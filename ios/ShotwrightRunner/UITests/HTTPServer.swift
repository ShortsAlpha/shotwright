import Foundation
import Network

/// Minimal HTTP/1.1 server on top of Network.framework (no third-party code).
/// One request per connection (`Connection: close`), bodies by Content-Length only.
struct HTTPRequest {
    let method: String
    let path: String
    let query: [String: String]
    let headers: [String: String]
    let body: Data

    func json() throws -> [String: Any] {
        if body.isEmpty { return [:] }
        guard let obj = try JSONSerialization.jsonObject(with: body) as? [String: Any] else {
            throw RunnerError("body must be a JSON object")
        }
        return obj
    }
}

struct HTTPResponse {
    var status: Int
    var contentType: String
    var body: Data

    static func json(_ obj: [String: Any], status: Int = 200) -> HTTPResponse {
        let data: Data
        if JSONSerialization.isValidJSONObject(obj),
           let d = try? JSONSerialization.data(withJSONObject: obj, options: []) {
            data = d
        } else {
            data = Data(#"{"ok":false,"error":"response was not serialisable"}"#.utf8)
        }
        return HTTPResponse(status: status, contentType: "application/json", body: data)
    }
}

struct RunnerError: Error, CustomStringConvertible {
    let description: String
    init(_ d: String) { description = d }
}

final class HTTPServer {
    typealias Handler = (HTTPRequest, @escaping (HTTPResponse) -> Void) -> Void

    private let listener: NWListener
    private let queue = DispatchQueue(label: "dev.shotwright.http")
    private let handler: Handler

    init(port: UInt16, handler: @escaping Handler) throws {
        let params = NWParameters.tcp
        params.allowLocalEndpointReuse = true
        // Loopback only: the simulator shares the Mac's network stack, so the agent on the Mac
        // reaches us at 127.0.0.1:<port>, and nothing on the LAN can.
        params.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: port)!)
        listener = try NWListener(using: params)
        self.handler = handler
    }

    func start(onState: @escaping (String) -> Void) {
        listener.stateUpdateHandler = { state in onState("\(state)") }
        listener.newConnectionHandler = { [weak self] conn in
            guard let self else { return }
            conn.start(queue: self.queue)
            self.receive(conn, buffer: Data())
        }
        listener.start(queue: queue)
    }

    func stop() { listener.cancel() }

    private func receive(_ conn: NWConnection, buffer: Data) {
        conn.receive(minimumIncompleteLength: 1, maximumLength: 1 << 20) { [weak self] data, _, isComplete, error in
            guard let self else { return }
            var buf = buffer
            if let data { buf.append(data) }
            switch Self.parse(buf) {
            case .some(.some(let req)):
                self.handler(req) { resp in self.send(conn, resp) }
            case .some(.none):
                self.send(conn, .json(["ok": false, "error": "bad request"], status: 400))
            case .none:
                if isComplete || error != nil { conn.cancel() } else { self.receive(conn, buffer: buf) }
            }
        }
    }

    /// nil = need more bytes; .some(nil) = malformed; .some(req) = complete request.
    static func parse(_ raw: Data) -> HTTPRequest?? {
        let buf = Data(raw)  // re-base indices at 0
        guard let headerEnd = buf.range(of: Data("\r\n\r\n".utf8)) else { return nil }
        let head = String(decoding: buf[0..<headerEnd.lowerBound], as: UTF8.self)
        var lines = head.components(separatedBy: "\r\n")
        let requestLine = lines.removeFirst().split(separator: " ")
        guard requestLine.count >= 2 else { return .some(nil) }
        var headers: [String: String] = [:]
        for line in lines {
            guard let i = line.firstIndex(of: ":") else { continue }
            headers[line[..<i].lowercased()] = line[line.index(after: i)...].trimmingCharacters(in: .whitespaces)
        }
        let length = Int(headers["content-length"] ?? "0") ?? 0
        let bodyStart = headerEnd.upperBound
        guard buf.count - bodyStart >= length else { return nil }
        let target = String(requestLine[1])
        let comps = URLComponents(string: target)
        var query: [String: String] = [:]
        comps?.queryItems?.forEach { query[$0.name] = $0.value ?? "" }
        return .some(HTTPRequest(method: String(requestLine[0]).uppercased(),
                                 path: comps?.path ?? target,
                                 query: query,
                                 headers: headers,
                                 body: buf.subdata(in: bodyStart..<(bodyStart + length))))
    }

    private func send(_ conn: NWConnection, _ resp: HTTPResponse) {
        let reason = [200: "OK", 400: "Bad Request", 404: "Not Found", 500: "Internal Server Error"][resp.status] ?? "OK"
        let head = "HTTP/1.1 \(resp.status) \(reason)\r\nContent-Type: \(resp.contentType)\r\n"
            + "Content-Length: \(resp.body.count)\r\nConnection: close\r\n\r\n"
        var out = Data(head.utf8)
        out.append(resp.body)
        conn.send(content: out, completion: .contentProcessed { _ in conn.cancel() })
    }
}
