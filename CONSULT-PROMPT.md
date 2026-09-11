# 相談プロンプト（GPT-5.6 Pro へ貼る用）

```markdown
# 相談: 音声⇄コーディングエージェントの2段構成を実装済み。設計の穴と次の一手を見てほしい

## 私のゴール
日本語で話しかける→コーディングエージェントが実際にリポジトリを編集→
好きなキャラ声で応答が返る。追加課金は最小限。できれば最終的に全二重（割り込み可）にしたい。

## 環境（実測済み・推測なし）
- Mac Apple Silicon
- Devin CLI $20プラン: ローカル実行の SWE-2 は全バリアント Free（devin models list で実測）。
  Paseo daemon 経由で `paseo send <agentId>` で session/prompt を注入できる（往路実証済み）。
- Codex CLI 0.153.4 prolite($100)プラン: ChatGPT OAuth ログイン。
  app-server の thread/realtime/* で gpt-live-1-codex を transport:webrtc 指定で
  ChatGPT OAuth が通ることを実測（APIキー不要）。ただし Codex週次枠(現100%、9/15回復)を消費。
- VOICEVOX engine (ずんだもん等) ローカル導入済み、HTTP 127.0.0.1:50021 で稼働中。
- sherpa-onnx + SenseVoice int8 + silero VAD: 日本語マイクASR、RTF 0.024 で実測動作。

## 現在の実装（動作確認済み）
### A経路（半二重・全無料・今日動く）
sherpa-onnx-vad-microphone-offline-asr (SenseVoice ja, silero VAD)
  → 発話テキスト → `paseo send <devinAgent>` → Devin SWE-2 が作業
  → `paseo inspect` が idle になるまで poll → `paseo logs` で返答行を抽出
  → VOICEVOX /audio_query → /synthesis → afplay で再生
実測: 往路「1+1は?」→「2だよ」抽出成功。TTS再生成功。
問題意識: 半二重、応答待ちで耳が止まる、長い作業中に無言になる。

### B経路（全二重・実装済み未検証）
codex app-server (stdio JSON-RPC, capabilities.experimentalApi)
  → thread/start → thread/realtime/start {transport:{type:"webrtc",sdp:offer},
    model:"gpt-live-1-codex", voice:"cove", outputModality:"audio"}
  → werift(純TS WebRTC) で offer生成 → thread/realtime/sdp の answer を setRemote
  → RTP opus で音声往復（opusscript でPCM変換）
実測: realtime/start は受理、ChatGPT認証通過。音声セッション開始のみ
  Codex週次リミット100%でブロック中（9/15 11:19 JST回復）。

## 声の着せ替え方針
- Live-1 出力をリアルタイムVC(Paravo/RVC)で後処理変換する案はあるが、
  「TTSで直接好きな声を合成(Style-Bert-VITS2/Irodori)」なら変換層自体が不要では？
- Paravoは自作声を学習できない（ライセンス済みキャラのみ）。

## 聞きたいこと（優先度順）
1. A経路の「作業中に無言」を解く設計: Devinの途中経過(Thought/Shellログ)を
   読み上げるべきか、雑談層を別に立てるべきか。UX的に正しい形は？
2. B経路(全二重)に進む価値は？Codex枠を音声で食うと本業コーディング枠が減る。
   A経路を「VAD割り込み+ストリーミングTTS」で半二重のまま速くする方が得策か？
3. Live-1の delegation を使わず transcript監視→paseo send で転送する設計の穴は？
   (例: 会話と作業指示の判定ミス、Devin応答をLive-1へ戻すタイミング)
4. 自作声の最短経路: Style-Bert-VITS2学習 vs Irodori VoiceDesign、
   品質/手間/日本語相性でどちらを選ぶべきか。学習データはIrodori生成でよいか？
5. この構成で見落としている致命的な問題(レイテンシ、権限、ライセンス等)を指摘してほしい。
```
```

## 補足（プロンプトに含めた実装詳細の所在）

- appserver.mjs / peer.mjs / devin.mjs / main.mjs = B経路
- voice-bridge.mjs = A経路（今回新設）
- models/ = SenseVoice int8 + silero VAD
- Devin音声セッション: `a235715a-af2a-4630-b0f4-1b8237b31c17`（Paseo・Bワークスペース）
