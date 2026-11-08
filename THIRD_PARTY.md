# 再利用元

- [ComfyUI Image Browser](https://github.com/laurigates/comfyui-image-browser) — MIT, Copyright (c) 2026 Lauri Gates. 固定commit: `e59981e7efefd94b45d8653212d821ea0d7230ce`。一覧、サムネイル、検索、フォルダ操作、メタデータ抽出、ComfyUIへのグラフ読込を再利用。Python部分には登録フォルダの解決・境界検査と、同時2件のワーカーによるサムネイル生成を追加。フロントエンドには一覧アダプター、ページ送り、Shift選択、コンパクト表示、通知の画面内表示、表示切替の公開、カードへの状態と操作の追加を実装しています。元のLICENSEを同梱。
- `@laurigates/comfy-modal-kit` 0.14.0 — MIT。既存ブラウザーと同じモーダル・スタイルの仕組みを使用し、フロントエンドへ同梱。
- Pillow / libwebp — ComfyUIにある既存ライブラリを使用。独自の画像コーデックは実装していません。
- Windows x64ではGoogle公式のlibwebp 1.6.0配布から `cwebp.exe` と `webpmux.exe` を同梱。`vendor/libwebp/README.md` に配布元とSHA256、同フォルダにCOPYING/PATENTSを保存。エンコードとEXIF埋め込みに使用し、Pillowによる復号照合・復元を継続します。
- ComfyUI — 既存の拡張登録API、HTTPルート、フォルダ設定、画像からのワークフロー読込とグラフ表示を使用。コアの変更なし。

新規部分は、既存ブラウザーへの操作追加、可逆コーデックの呼び出しと照合、置き換え時の整合性確認、PNG付随情報の保管と復元、容量を制限した展開キャッシュです。

本体の新規コードはMITライセンス（Copyright (c) 2026 kino-6）です。LICENSEを参照してください。上流由来部分は、それぞれ同梱したライセンスと著作権表示を保持します。
