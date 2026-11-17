# KuroStream (YouTubeServerBeta-)

自前マルチノード Invidious API クラスタ・リバースプロキシ・自動復旧ストリームエンジン・海外動画自動翻訳・正規 Edu再生（`youtubeeducation.com`）・全サーバー死活監視を搭載した動画配信プラットフォームです。

## 主な機能

- **自前 Invidious API サーバー & 7ノード自動フォールバッククラスタ**
  - ポート `3001` の内部オリジンとポート `3000` のリバースプロキシ・WAF層による2段構成
  - 安定型・高速型・高画質型など7つの内部クラスタノードによる自動フォールバック
- **マルチエンジン高画質・超高速再生**
  - Googlevideo 高速直接プロキシ再生
  - 結合MP4再生（FFmpeg映像+音声結合 / シーク同期）
  - HLS アダプティブ再生（`hls.js` + 動的セグメント生成）
  - 映像+音声デュアルトラック同期再生
  - 正規 Edu再生（`https://www.youtubeeducation.com/embed/...` による Classroom / Kahoot! 対応埋め込み）
- **再生エラー自動復旧化（外部 Invidious / Zernio / Piped）**
  - `api.invidious.io` からの生存インスタンス動的探索および Zernio / Piped ノードの並列レーシング復旧
- **海外動画の自動翻訳 & WebVTT 字幕翻訳**
  - 設定モーダルから自動翻訳 ON/OFF、翻訳先言語（日本語・英語・韓国語・中国語・スペイン語・フランス語）、翻訳対象（タイトル・概要欄・コメント・字幕）を変更可能
- **サーバー死活監視モニター**
  - 自前7クラスタ・外部 Invidious・Zernio・Piped の生存（ALIVE）/ 遅延・制限（DEGRADED）/ 停止（DEAD）および応答速度（ms）を確認可能

## セットアップ & 起動方法

```bash
npm install
cp .env.example .env
# 開発サーバー起動 (ポート 3000)
npm run dev
```

本番ビルドおよび起動：

```bash
npm run build
npm start
```

## 環境変数

- `GEMINI_API_KEY`（任意）: 設定すると自動翻訳で Gemini API を優先使用し、未設定時はフリー翻訳フォールバックを使用します。
- `APP_URL`（任意）: ホスティング先の公開URL。
