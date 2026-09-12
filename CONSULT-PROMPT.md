# 相談プロンプト v4（ChatGPT Pro へ — 実装状態報告つき）

```markdown
# 続報: 前回レビュー指摘を修正した。残りの設計判断を見てほしい

## 前回の指摘への対応（実装済み・metastudio tools/live1-voice-bridge/）

### P0「停止が再生完了待ちの後になる」→ 修正済み
speak-replies.mjs を全面書換え:
- 停止監視は500msの独立タイマー（daemon.logのvoice mode変化 + ~/.paseo/voice-mute
  フラグを監視）。再生完了を待たない
- 世代番号(generation)を導入。OFF/ミュートで加算し、キューを全破棄＋afplayをSIGKILL
- TTS合成の各await後・再生直前に世代を照合し、古い世代の合成結果は破棄
  （「止めたのに後から喋る」対策）

### P0「同文返答が二度目に読まれない」→ 修正済み
重複キーを (直前の[User]文脈 + 本文) に変更。別依頼の同文返答は別キーとして読む。
ログ末尾一致による確定推測は廃止。

### P0「ログパーサの役割推測が不確実」→ 方式変更
paseo logs のポーリングをやめ、`paseo attach` のライブストリームへ移行。
さらに重要な実測: Devinの思考(Reasoning)がタグ無し裸行として混ざって届き、
行頭タグ推測では User入力/思考/返答を原理的に区別できないことが判明。
→ 明示マーカー方式に変更: 「🔊」で始まる行だけを読み上げる。
エージェント側には「音声応答文は行頭に🔊」と指示（専用音声セッションには送信済み、
動作確認済み）。マーカーが無い行は思考・ユーザー入力・ログを問わず読まない。
履歴ダンプは接続後1.5秒の無出力で「現在地点」とみなし読み上げない。

### P0「エコー抑止が本物の入力を消す」→ 縮小
- speak-replies が実再生区間を /tmp/live1-playing.json {until, text} に記録
  （途中停止したら実際の終了時刻に更新。推定残りは残らない）
- シムが捨てるのは「実再生中+0.4秒」のみ。再生直後6秒以内は8文字以上の近一致
  (85%/部分一致)のみ捨てる。30秒・70%類似の広域ドロップは廃止。
- スピーカー運用でのループ完全対策(AEC/PTT)は未実装＝残課題。盲目時間は
  shimログに "STT dropped" として記録される（隠さない）。

### P1「WAVを44byte固定と仮定」→ 修正済み
- RIFFチャンクを実際に歩くparseWav()。fmt(format=1 PCM16のみ)/dataを検証
- stereo→Lチャンネルでモノラル化、3ch以上は拒否
- 非WAVはafconvert→再解析、変換失敗は422（rawフォールバック廃止）
- リクエスト25MB上限、TTS入力2000字上限、一時ファイルはfinallyで削除
- VOICEVOXへ outputSamplingRate=24000 を明示指定、応答もWAV解析してpcm取出し

### P1「main.mjsはWAV往復PoC」→ 現状維持（実験経路として分離済み）

## 現在の構成
音声ボタンON(Paseo) → VAD/ターンスイッチ(Paseoローカルワーカー) →
シムSTT(SenseVoice常駐,実測0.13s) → <spoken-input>付きでDevinへ送信 →
Devin返答(🔊マーカー行)を attachストリーム経由で検出 → VOICEVOX → afplay。
音声OFF/ミュート → 世代+1 → キュー破棄・再生即停止・遅延合成も破棄。

## 次に相談したい点
1. 🔊マーカー方式の弱点は？（エージェントが忘れると無音。フォールバックとして
   「返答確定イベント」の構造化ソースをdaemonから取る方法があれば知りたい。
   daemonのfetch_agent_timeline WSを直接叩く道はあるか）
2. Paseoをフォークせず「返答音声ON/OFF」「今だけ停止」をUIに足す最小拡張案
3. 表示タグ(<spoken-input>)を画面から隠す最小パッチ方針（前回の回答の
   source/displayText分離案を具体化してほしい）
4. 半二重バージイン: 再生中のユーザー発話を取るための最小構成（ヘッドホン前提）
5. 残っている致命的欠陥は？
```

## ファイル対応表

| ファイル | 役割 |
|---|---|
| local-openai-shim.mjs | OpenAI互換API (STT=SenseVoice永続, TTS=VOICEVOX)＋狭いエコー抑止＋RIFF検証 |
| speak-replies.mjs | attachストリーム→🔊マーカー行だけ読み上げ。世代番号・即停止・ミュート制御 |
| voice-bridge.mjs | 自立型: マイクASR→Devin→TTS（Paseo音声モード不要） |
| main.mjs + lib/ | Live-1全二重ブリッジ（クオータ回復後に検証） |
