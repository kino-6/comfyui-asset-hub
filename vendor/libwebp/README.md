# Windows x64 codec tools

Unmodified cwebp.exe and webpmux.exe from Google's libwebp 1.6.0 Windows x64 release:

https://storage.googleapis.com/downloads.webmproject.org/releases/webp/libwebp-1.6.0-windows-x64.zip

Upstream: https://developers.google.com/speed/webp/download

SHA256:

- cwebp.exe: `6a2f5cb5dce71366353ab1d9caf9c636e039f25703acfce1c148eed346f2f72a`
- webpmux.exe: `98e33ac84759f31a9f21005889f0e01c3ddd51a57452a24426a2260a91945061`

COPYING and PATENTS are from the upstream v1.6.0 tag. These tools are invoked locally without a shell or network requests. No PATH/system installation is required. Other operating systems retain the existing Pillow backend; this Windows integration does not establish their performance.
