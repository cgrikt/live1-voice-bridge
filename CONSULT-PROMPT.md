# 相談プロンプト v2（GPT-5.6 Pro へ貼る用）

```markdown
# 相談: 日本語音声⇄SWE-2コーディングを無料で実用化した。次の設計判断を見てほしい

## 私のゴール
日本語で話しかける→コーディングエージェント(SWE-2)が実際にリポジトリを編集→
好きなキャラ声で応答が返る。追加課金ゼロ。できれば全二重(割り込み可)まで行きたい。

## 環境（全て実測済み）
- Mac Apple Silicon
- Devin CLI $20プラン: SWE-2は全バリアントFree表示。Paseo daemon経由 `paseo send` で注入可。
- Codex prolite($100): codex app-server thread/realtime/* で gpt-live-1-codex を
  webrtc transport + ChatGPT OAuth で開始要求まで受理されることを確認。
  ただし Codex週次枠100%消費中で実セッションは9/15 11:19 JSTリセット待ち。
- Grok 4.6無料枠も枯渇(24h)。Claude Codeは組織がサブスク利用を無効化。
- つまり現時点で無料で動く推論は Devin SWE-2 のみ。

## 現在の実装（GitHub: https://github.com/cgrikt/live1-voice-bridge）

### 経路1: Paseo純正音声モード + ローカルOpenAI互換シム
Paseoは providers.openai.{stt,tts}.baseUrl を受け付ける。
local-openai-shim.mjs が 127.0.0.1:8741 で:
  - POST /v1/audio/transcriptions → sherpa-onnx-offline-websocket-server
    (SenseVoice int8・永続モデル・日本語) → 実測0.129秒
  - POST /v1/audio/speech → VOICEVOX(ずんだもん) → raw PCM s16le 24kHz
~/.paseo/config.json: features.voiceMode={enabled:true, stt.provider:"openai",
  language:"ja", tts.provider:"openai"} + providers.openai.{stt,tts}.baseUrl
切替は provider を "local"↔"openai" にするだけ。
実測: 音声ボタン→日本語認識→Devinへ送信まで動作。

【未解決】Paseo音声モードは「エージェントがspeak MCPツールを呼ぶ」設計。
Devin CLIはACP経由でspeakツールが注入されないため、エージェントの返答が
音声化されない。回避として speak-replies.mjs が paseo logs を2秒ポーリングし、
新しいアシスタント行をVOICEVOXで読み上げる（動作確認済み）。

### 経路2: 自立音声ブリッジ voice-bridge.mjs
sherpa-onnx-vad-microphone-offline-asr (SenseVoice ja + silero VAD、発話区切り自動)
  → 日本語発話 → paseo send → Devin SWE-2 → paseo logs で返答抽出 → VOICEVOX → afplay
実測: マイク認識・送信・返答抽出・TTS再生まで全工程動作。

### 経路3: Live-1全二重 main.mjs（9/15まで枠待ち）
codex app-server + werift WebRTC。認証・受理は確認済み、音声往復は未検証。

## 設計上の疑問（優先度順）
1. Devin(ACP)へspeak MCPツールを届ける方法はあるか？ACP session/newの
   mcpServers注入がDevin CLIで有効か。無理ならlogsポーリング読み上げでよいか、
   もっと正確な完了検知(session/updateイベント購読など)はあるか？
2. 全二重化はLive-1待ちだが、A経路でも「話しかけたら再生停止(バージイン)」は
   実装可能。半二重をどこまで全二重に近づける価値があるか？
3. Live-1の音声をリアルタイムVC(Beatrice等)で後処理変換 vs 
   TTS直接合成。会話の自然さを保ったままキャラ声にする最適解は？
4. この構成の残りの致命的欠陥は？
```

## ファイル対応表

| ファイル | 役割 |
|---|---|
| local-openai-shim.mjs | OpenAI互換API (STT=SenseVoice, TTS=VOICEVOX) |
| speak-replies.mjs | paseo logs監視→新しい返答をずんだもんで読み上げ |
| voice-bridge.mjs | 自立型: マイクASR→Devin→TTS（Paseo音声モード不要） |
| main.mjs + lib/ | Live-1全二重ブリッジ（9/15クオータ回復後に検証） |
