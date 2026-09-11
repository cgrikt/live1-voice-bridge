# live1-voice-bridge

## A経路（今日から無料で動く）: `voice-bridge.mjs`

日本語マイク → SenseVoice(ローカルASR) → `paseo send` → Devin SWE-2 → VOICEVOXずんだもん → afplay

```bash
# 前提: VOICEVOX engine 起動済み (metastudio-work/scripts/voicevox-engine-headless.sh)
node voice-bridge.mjs                 # Devin音声セッション a235715a へ転送
node voice-bridge.mjs <agentId>       # 別エージェントへ
```

実測済み: SenseVoice int8 は日本語を RTF 0.024 で転写。paseo send→inspect→logs で往路成立。
TTS はずんだもん(speaker=3)で合成・再生確認済み。マイクは sherpa-onnx-vad-microphone-offline-asr
（silero VAD が発話区切りを自動検出）。

## B経路（9/15クオータ回復後）: `main.mjs`

GPT-Live-1（`gpt-live-1-codex`）を codex app-server 経由で **ChatGPT サブスク認証**で使う
全二重ブリッジ。作業系の発話を Devin CLI の SWE-2（無料）へ投げる。

## 構成

```
mic/WAV → [werift WebRTC peer] → codex app-server thread/realtime/*
                                    ↑ ChatGPT OAuth（APIキー不要）
         ← Live-1 音声（opus→PCM）→ out.wav → BlackHole → Paravo/RVC → speaker

transcript(done, user) → 作業トリガー判定 → paseo send <DEVIN_AGENT_ID> → SWE-2
```

## 実測済み（2026-09-11, codex-cli 0.153.4）

- `initialize` + `capabilities.experimentalApi: true` → OK
- `thread/start` → OK
- `thread/realtime/listVoices` → OK
- `thread/realtime/start` `transport:{type:"webrtc", sdp}` → **ChatGPT認証で通過**
  （`websocket` transport は `requires API key auth` で不可）
- v1 系の声: juniper/maple/spruce/ember/vale/breeze/arbor/sol/cove（v2の marin 等は不可）
- **残る壁**: Codex 週次リミット 100% → 9/15 11:19 AM JST に回復。Live-1 はこの枠を食う。

## 使い方

```bash
npm i
node main.mjs                      # say で日本語テスト音声を自動生成して送信
node main.mjs input.wav out.wav    # 48kHz mono s16 WAV
DEVIN_AGENT_ID=<paseoのagent id> node main.mjs   # 作業発話をDevinへ転送
FORWARD_ALL=1 DEVIN_AGENT_ID=... node main.mjs   # 全発話を転送
```

環境変数: `LIVE_MODEL`（既定 gpt-live-1-codex）/ `LIVE_VOICE`（既定 cove）/ `LIVE_PROMPT`

## ボイチェン（RVC系）経路

Live-1 の出力 PCM → 仮想オーディオデバイス（BlackHole: `brew install blackhole-2ch`）
→ リアルタイムVC（w-okada/voice-changer または Paravo）→ スピーカー。

二重音声にならない理由: 元音声は仮想デバイス内だけを流れ、人が聞くのは変換後のみ。
PoC は今 `out.wav` に書く形。リアルタイム化する場合は `onAudioPcm` で
BlackHole デバイスへストリーム再生する（`ffplay -nodisp -autoexit -f s16le -ar 48000 -ac 1 -` にパイプ等）。

## 未検証（クオータ回復後に確認）

- SDP answer の受理 → DTLS/ICE 確立 → 音声往復
- appendAudio/appendSpeech が webrtc transport で使えるか（現状 PoC は RTP 直送）
- Live-1 の delegation → Devin 転送の粒度
