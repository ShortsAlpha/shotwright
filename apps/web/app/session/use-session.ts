"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentParams, AgentResult, Frame } from "@shotwright/core";
import { EMPTY_JOBS, applyJobEvent, type JobAction, type JobsSnapshot } from "../../lib/jobs/state.ts";
import {
  CLOSE_SESSION_NOT_FOUND,
  type LogEntry,
  type SessionState,
  type UiMethod,
  type UiServerMessage,
} from "../../lib/ui-protocol.ts";

export type SocketStatus = "connecting" | "open" | "reconnecting" | "ended";

export type CallFn = <M extends UiMethod>(method: M, params: AgentParams<M>) => Promise<AgentResult<M>>;

/** Starts an exploration or a replay, or cancels the running job. */
export type JobFn = (action: JobAction, params?: unknown) => Promise<unknown>;

export interface SessionApi {
  readonly status: SocketStatus;
  readonly state: SessionState | null;
  readonly logs: readonly LogEntry[];
  readonly jobs: JobsSnapshot;
  readonly call: CallFn;
  readonly job: JobFn;
  /** Frames bypass React state; the live view draws them straight into an <img>. */
  readonly subscribeFrames: (listener: (frame: Frame) => void) => () => void;
  readonly clearLogs: () => void;
}

const MAX_LOGS = 500;

/** The browser end of the `/ui` socket: state, logs, frames and calls, with reconnects. */
export function useSession(): SessionApi {
  const [status, setStatus] = useState<SocketStatus>("connecting");
  const [state, setState] = useState<SessionState | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [jobs, setJobs] = useState<JobsSnapshot>(EMPTY_JOBS);
  const socket = useRef<WebSocket | null>(null);
  const pending = useRef(new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>());
  const frameListeners = useRef(new Set<(frame: Frame) => void>());
  const nextId = useRef(1);

  useEffect(() => {
    let stopped = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const rejectAll = (message: string) => {
      for (const { reject } of pending.current.values()) reject(new Error(message));
      pending.current.clear();
    };

    const open = () => {
      const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ui`);
      socket.current = ws;
      ws.onopen = () => {
        attempt = 0;
        setStatus("open");
      };
      ws.onmessage = (event) => {
        const message = JSON.parse(event.data as string) as UiServerMessage;
        switch (message.type) {
          case "frame":
            for (const listener of frameListeners.current) listener(message);
            break;
          case "state":
            setState(message.state);
            break;
          case "jobs":
            setJobs(message.snapshot);
            break;
          case "job.event":
            setJobs((previous) => applyJobEvent(previous, message.event));
            break;
          case "log":
            setLogs((previous) => {
              const lastId = previous.at(-1)?.id ?? 0;
              const fresh = message.entries.filter((entry) => entry.id > lastId);
              return fresh.length === 0 ? previous : [...previous, ...fresh].slice(-MAX_LOGS);
            });
            break;
          case "result": {
            const waiter = pending.current.get(message.id);
            if (!waiter) break;
            pending.current.delete(message.id);
            if (message.ok) waiter.resolve(message.value);
            else waiter.reject(new Error(message.error?.message ?? "The call failed"));
            break;
          }
          case "error":
            break;
        }
      };
      ws.onclose = (event) => {
        if (socket.current === ws) socket.current = null;
        rejectAll("Lost the connection to the server");
        if (stopped) return;
        if (event.code === CLOSE_SESSION_NOT_FOUND) {
          setStatus("ended");
          return;
        }
        setStatus("reconnecting");
        timer = setTimeout(open, Math.min(10_000, 500 * 2 ** attempt++));
      };
    };

    open();
    return () => {
      stopped = true;
      clearTimeout(timer);
      socket.current?.close();
      rejectAll("Closed");
    };
  }, []);

  const send = useCallback((message: Record<string, unknown>): Promise<unknown> => {
    const ws = socket.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error("Not connected to the server"));
    const id = `b${nextId.current++}`;
    return new Promise((resolve, reject) => {
      pending.current.set(id, { resolve, reject });
      ws.send(JSON.stringify({ ...message, id }));
    });
  }, []);

  const call = useCallback<CallFn>(
    (method, params) => send({ type: "call", method, params }) as Promise<AgentResult<typeof method>>,
    [send],
  );

  const job = useCallback<JobFn>((action, params) => send({ type: "job", action, params }), [send]);

  const subscribeFrames = useCallback((listener: (frame: Frame) => void) => {
    frameListeners.current.add(listener);
    return () => {
      frameListeners.current.delete(listener);
    };
  }, []);

  const clearLogs = useCallback(() => setLogs([]), []);

  return { status, state, logs, jobs, call, job, subscribeFrames, clearLogs };
}
