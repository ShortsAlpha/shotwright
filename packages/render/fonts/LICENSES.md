# Bundled fonts

Every font in `files/` is licensed under the **SIL Open Font License 1.1** (OFL-1.1). The full
license text for each family, with its copyright line, is in `licenses/`. The OFL allows bundling,
embedding and redistributing the fonts with software, including commercial software, as long as the
fonts are not sold on their own and the license travels with them. None of the fonts is renamed or
modified by us; we do not use any Reserved Font Name.

Source: Google Fonts (github.com/google/fonts), as WOFF2 files repackaged by Fontsource
(cdn.jsdelivr.net/fontsource). Latin-script and Indic families are variable fonts (wght axis);
CJK families are the Bold (700) weight of the Google Fonts language subset (common characters of
that language) to keep the repository small. Regenerate with `npm run fonts:fetch -w @shotwright/render`;
`manifest.json` records each file's unicode range, size and SHA-256.

| Family | Scripts (locales) | Weights | Version | Copyright | License | Size |
|---|---|---|---|---|---|---|
| Inter | Latin, Cyrillic, Greek, Vietnamese | variable 100–900 | v20 (fontsource 5.3.0) | Copyright 2020 The Inter Project Authors (https://github.com/rsms/inter) | [OFL-1.1](licenses/inter-OFL.txt) | 213 KB |
| Noto Sans Arabic | Arabic (ar, fa, ur) | variable 100–900 | v33 (fontsource 5.3.0) | Copyright 2022 The Noto Project Authors (https://github.com/notofonts/arabic) | [OFL-1.1](licenses/noto-sans-arabic-OFL.txt) | 162 KB |
| Noto Sans Hebrew | Hebrew (he) | variable 100–900 | v50 (fontsource 5.3.0) | Copyright 2022 The Noto Project Authors (https://github.com/notofonts/hebrew) | [OFL-1.1](licenses/noto-sans-hebrew-OFL.txt) | 12 KB |
| Noto Sans Thai | Thai (th) | variable 100–900 | v29 (fontsource 5.3.0) | Copyright 2022 The Noto Project Authors (https://github.com/notofonts/thai) | [OFL-1.1](licenses/noto-sans-thai-OFL.txt) | 26 KB |
| Noto Sans Devanagari | Devanagari (hi, mr) | variable 100–900 | v30 (fontsource 5.3.0) | Copyright 2022 The Noto Project Authors (https://github.com/notofonts/devanagari) | [OFL-1.1](licenses/noto-sans-devanagari-OFL.txt) | 118 KB |
| Noto Sans Bengali | Bengali (bn) | variable 100–900 | v33 (fontsource 5.3.0) | Copyright 2022 The Noto Project Authors (https://github.com/notofonts/bengali) | [OFL-1.1](licenses/noto-sans-bengali-OFL.txt) | 105 KB |
| Noto Sans Gujarati | Gujarati (gu) | variable 100–900 | v27 (fontsource 5.3.0) | Copyright 2022 The Noto Project Authors (https://github.com/notofonts/gujarati) | [OFL-1.1](licenses/noto-sans-gujarati-OFL.txt) | 110 KB |
| Noto Sans Gurmukhi | Gurmukhi (pa) | variable 100–900 | v29 (fontsource 5.3.0) | Copyright 2022 The Noto Project Authors (https://github.com/notofonts/gurmukhi) | [OFL-1.1](licenses/noto-sans-gurmukhi-OFL.txt) | 33 KB |
| Noto Sans Kannada | Kannada (kn) | variable 100–900 | v32 (fontsource 5.3.0) | Copyright 2022 The Noto Project Authors (https://github.com/notofonts/kannada) | [OFL-1.1](licenses/noto-sans-kannada-OFL.txt) | 89 KB |
| Noto Sans Malayalam | Malayalam (ml) | variable 100–900 | v29 (fontsource 5.3.0) | Copyright 2022 The Noto Project Authors (https://github.com/notofonts/malayalam) | [OFL-1.1](licenses/noto-sans-malayalam-OFL.txt) | 87 KB |
| Noto Sans Oriya | Odia (or) | variable 100–900 | v35 (fontsource 5.3.0) | Copyright 2022 The Noto Project Authors (https://github.com/notofonts/oriya) | [OFL-1.1](licenses/noto-sans-oriya-OFL.txt) | 97 KB |
| Noto Sans Tamil | Tamil (ta) | variable 100–900 | v31 (fontsource 5.3.0) | Copyright 2022 The Noto Project Authors (https://github.com/notofonts/tamil) | [OFL-1.1](licenses/noto-sans-tamil-OFL.txt) | 49 KB |
| Noto Sans Telugu | Telugu (te) | variable 100–900 | v30 (fontsource 5.3.0) | Copyright 2022 The Noto Project Authors (https://github.com/notofonts/telugu) | [OFL-1.1](licenses/noto-sans-telugu-OFL.txt) | 121 KB |
| Noto Sans JP | Japanese (ja) | 700 | v57 (fontsource 5.3.1) | Copyright 2014-2021 Adobe (http://www.adobe.com/), with Reserved Font Name 'Source' | [OFL-1.1](licenses/noto-sans-jp-OFL.txt) | 1131 KB |
| Noto Sans KR | Korean (ko) | 700 | v40 (fontsource 5.3.1) | Copyright 2014-2021 Adobe (http://www.adobe.com/), with Reserved Font Name 'Source' | [OFL-1.1](licenses/noto-sans-kr-OFL.txt) | 546 KB |
| Noto Sans SC | Simplified Chinese (zh-Hans) | 700 | v41 (fontsource 5.3.1) | Copyright 2014-2021 Adobe (http://www.adobe.com/), with Reserved Font Name 'Source' | [OFL-1.1](licenses/noto-sans-sc-OFL.txt) | 1145 KB |
| Noto Sans TC | Traditional Chinese (zh-Hant) | 700 | v40 (fontsource 5.3.1) | Copyright 2014-2021 Adobe (http://www.adobe.com/), with Reserved Font Name 'Source' | [OFL-1.1](licenses/noto-sans-tc-OFL.txt) | 997 KB |
