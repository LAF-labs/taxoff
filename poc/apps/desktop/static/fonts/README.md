# 세금계산서 PDF 글꼴

앱이 만드는 세금계산서 PDF(`src/invoice-form.ts`, `src/invoice-pdf.ts`)에 심는 글꼴이다. OS 글꼴에 기대지 않아 Mac과 Windows에서 같은 모양이고, PDF에는 쓴 글자만 부분 집합으로 들어간다(한 장 약 30KB).

- `NotoSansKR-Regular.invoice.woff2`, `NotoSansKR-Bold.invoice.woff2`: Noto Sans KR 2.004(SIL OFL 1.1, `OFL.txt`)의 부분 집합.
- 글자: ASCII, Latin-1, 한글 음절 11,172자(U+AC00–D7A3), 호환 자모, 괄호 문자(㈜ 등), 전각 ASCII, 몇 가지 기호.
- 원본: npm `@expo-google-fonts/noto-sans-kr@0.4.4`의 `NotoSansKR_400Regular.ttf`(sha256 `b4a747e7…eef4`), `NotoSansKR_700Bold.ttf`(sha256 `c76f806d…e9cc`).

다시 만들기(fonttools 4.x):

```sh
python3 - <<'PY'
cs = set(range(0x20, 0x7f)) | set(range(0xa0, 0x100)) | set(range(0xac00, 0xd7a4)) | set(range(0x3131, 0x318f)) | set(range(0x3200, 0x3220)) | set(range(0x3260, 0x3280)) | set(range(0xff01, 0xff5f))
cs |= {0x2010, 0x2013, 0x2014, 0x2018, 0x2019, 0x201c, 0x201d, 0x2026, 0x203b, 0x20a9, 0x2116, 0x2122, 0x2190, 0x2191, 0x2192, 0x2193, 0x25cb, 0x25cf, 0x25a1, 0x25a0, 0x3000, 0x3001, 0x3002, 0x3008, 0x3009, 0x300c, 0x300d, 0x3010, 0x3011, 0x33a1, 0x338f, 0x339c, 0x339d, 0x339e, 0x33a5, 0x33c4}
open('u.txt', 'w').write(','.join('U+%04X' % c for c in sorted(cs)))
PY
pyftsubset NotoSansKR_400Regular.ttf --unicodes-file=u.txt --flavor=woff2 --layout-features='*' --no-hinting --desubroutinize --output-file=NotoSansKR-Regular.invoice.woff2
pyftsubset NotoSansKR_700Bold.ttf --unicodes-file=u.txt --flavor=woff2 --layout-features='*' --no-hinting --desubroutinize --output-file=NotoSansKR-Bold.invoice.woff2
```

목록에 없는 글자(한자 등)는 OS 글꼴로 대신 그린다.
