#!/bin/bash
# 보안칩 도우미를 앱 묶음(touchid.app)으로 만든다(arm64와 x64를 합친 실행 파일 하나). 쓰는 법: bash build.sh <나올 touchid.app 경로>
# 맨 실행 파일로 두면 Touch ID 창 제목이 "touchid", 아이콘이 exec로 뜬다. 묶음이면 Info.plist의 이름(택스오프)과 아이콘으로 뜬다.
set -euo pipefail
out="${1:?나올 touchid.app 경로}"
here="$(cd "$(dirname "$0")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
for arch in arm64 x86_64; do
  swiftc -O -target "$arch-apple-macos13" "$here/touchid.swift" -o "$tmp/$arch"
done
rm -rf "$out"
mkdir -p "$out/Contents/MacOS" "$out/Contents/Resources"
lipo -create "$tmp/arm64" "$tmp/x86_64" -output "$out/Contents/MacOS/touchid"
cp "$here/Info.plist" "$out/Contents/Info.plist"
cp "$here/touchid.icns" "$out/Contents/Resources/touchid.icns"
