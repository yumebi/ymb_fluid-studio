# WebGL Viscous Fluid &mdash; 化粧品サイト向け原液・美容液エフェクト

![WebGL2](https://img.shields.io/badge/WebGL-2.0-blue?style=flat-square)
![License](https://img.shields.io/badge/License-MIT-green?style=flat-square)
![Dependencies](https://img.shields.io/badge/Dependencies-Zero-brightgreen?style=flat-square)
![Vanilla JS](https://img.shields.io/badge/Vanilla-JS-yellow?style=flat-square)

## 概要

化粧品サイト向けの「原液・美容液」質感に特化したWebGL2流体エフェクトライブラリです。依存ゼロ・`<script>` タグ1行で埋め込み可能。オリジナル実装。

セミラグランジュ移流 + ヤコビ圧力射影という古典的な格子流体シミュレーション手法をベースに、粘性拡散パス・原液グロス表現・透明ジェルモード・vorticity confinement など、化粧品LP向けの演出に寄せたオリジナルの表現レイヤーを重ねています。

## デモ

| ページ | 内容 | GitHub Pages URL |
| --- | --- | --- |
| スタジオ(調整UI付き) | 全パラメータをリアルタイム調整できる統合デモ | https://yumebi.github.io/ymb_fluid-studio/fluid-studio.html?ui=1 |
| スタジオ &mdash; 原液(黒) | プリセット直リンク | https://yumebi.github.io/ymb_fluid-studio/fluid-studio.html?preset=serumDark |
| スタジオ &mdash; 原液(白) | プリセット直リンク | https://yumebi.github.io/ymb_fluid-studio/fluid-studio.html?preset=serumWhite |
| スタジオ &mdash; クリア | プリセット直リンク | https://yumebi.github.io/ymb_fluid-studio/fluid-studio.html?preset=clear |
| スタジオ &mdash; スプラッシュ | プリセット直リンク | https://yumebi.github.io/ymb_fluid-studio/fluid-studio.html?preset=splash |
| 埋め込みサンプル(LP実装例) | 実際のLPヒーローセクションを想定した埋め込みパターン | https://yumebi.github.io/ymb_fluid-studio/embed-sample.html |
| 原液デモ(ダーク背景) | 黒背景での原液系グロス表現 | https://yumebi.github.io/ymb_fluid-studio/fluid.html |
| 原液デモ(ホワイト背景) | 白背景プロファイル + 原液/クリアジェル切替 | https://yumebi.github.io/ymb_fluid-studio/fluid-white.html |
| スプラッシュデモ | 低粘性 + vorticity confinement + レインボー | https://yumebi.github.io/ymb_fluid-studio/fluid-splash.html |
| インクフロー(グロー) | displayMode='ink' + 強めのvorticityとHDR発色・広いブルームで暗背景に色とりどりのインクが渦巻くデモ | https://yumebi.github.io/ymb_fluid-studio/fluid-ink.html |
| メタボール版(軽量・旧実装) | 格子流体ではなくメタボールフィールドによる旧実装 | https://yumebi.github.io/ymb_fluid-studio/metaball.html |
| 金粉ラメシマー | GPUパーティクルの金粉フレークが煌めくスタンドアロンエフェクト | https://yumebi.github.io/ymb_fluid-studio/gold-shimmer.html |
| 薄膜干渉パール | シャボン膜のような虹色パール調の薄膜干渉エフェクト | https://yumebi.github.io/ymb_fluid-studio/thin-film.html |
| 水面コースティクス | 水面越しの光のコースティクスと波紋リング | https://yumebi.github.io/ymb_fluid-studio/water-caustics.html |
| 波動方程式リップル | 格子上の波動方程式リアルタイムシミュレーションによる本物の波紋、画像屈折対応 | https://yumebi.github.io/ymb_fluid-studio/water-ripple.html |
| シルクサテン | 異方性反射のサテン地質感エフェクト | https://yumebi.github.io/ymb_fluid-studio/silk-cloth.html |
| トップページ | デモ一覧ランディングページ | https://yumebi.github.io/ymb_fluid-studio/ |

## 主な機能

- 🌊 格子流体シミュレーション(セミラグランジュ移流 + 圧力射影)
- 🧴 粘性制御(Jacobi拡散)
- ✨ 原液グロス表現(擬似法線 + スペキュラ + リムライト)
- 💧 透明ジェルモード
- 🌀 vorticity confinement(低粘性カラフル表現)
- 🖱️ カーソル追従 / アンビエントの2モード
- 🌓 ダーク / ライト背景プロファイル
- 🎨 レインボーカラーモード

## 使い方

### 最小埋め込みスニペット

```html
<canvas data-fluid-sim
        data-mode="cursor"
        data-background="light"
        data-color-a="#8a2438"
        data-color-b="#f2c6c2"
        style="position:absolute; inset:0; width:100%; height:100%; display:block;"></canvas>
<script src="fluid-sim.js"></script>
```

canvas要素に `data-fluid-sim` を付けるだけで、DOMContentLoaded時(またはスクリプト実行時点でDOMが既に準備済みなら即座に)自動初期化されます。生成されたインスタンスは `canvas._fluidSimInstance` に保存されます。

canvas上に重ねるオーバーレイ要素には `pointer-events:none` を指定してください(ボタン等クリックさせたい要素だけ `pointer-events:auto` で個別に復帰させます)。ポインター追従は canvas 自身に対する `pointermove` / `pointerdown` を監視しているため、これを怠るとオーバーレイがカーソルイベントを遮ってしまいます。

### data-属性リファレンス(auto-init)

| 属性 | 型 | デフォルト | 説明 |
| --- | --- | --- | --- |
| `data-mode` | `"cursor"` \| `"ambient"` | `cursor` | カーソル追従 / 自動アンビエント |
| `data-background` | `"dark"` \| `"light"` | `dark` | 表示シェーディングのプロファイル |
| `data-color-mode` | `"palette"` \| `"rainbow"` | `palette` | 色モード(パレット固定 / 虹色) |
| `data-color-a` | hex color | `#4a0f16` | 基準色A |
| `data-color-b` | hex color | `#f0b8ae` | 基準色B |
| `data-viscosity` | 0..1 | `0.5` | 粘度 |
| `data-speed` | 0.05..5 | `1` | シミュレーション速度 |
| `data-splat-radius` | 0.01..1 | `0.25` | 注入(splat)半径 |
| `data-curl` / `data-curl-strength` | 0..80 | `0` | vorticity confinement強度(0でオフ) |
| `data-dye-dissipation` | 0..1 | `0.995` | 色の残留(散逸)率 |
| `data-velocity-dissipation` | 0..1 | `0.98` | 速度の残留(散逸)率 |
| `data-pressure-iterations` | 10..80 | `40` | 圧力ヤコビ反復回数 |
| `data-viscosity-iterations` | 0..50 | `20` | 粘性ヤコビ反復回数 |
| `data-display-mode` | `"gloss"` \| `"ink"` | `gloss` | 表示パイプライン(擬似法線グロス / 生ダイ直描き) |
| `data-bloom-strength` | 0..2 | `0` | ブルーム強度(0で完全無効・パス自体をスキップ) |
| `data-specular` | 0..2 | `0.9` | ツヤ(スペキュラ)強さ |
| `data-shininess` | 8..200 | `60` | ツヤの鋭さ |
| `data-fresnel` | 0..1 | `0.35` | 縁の光(リムライト) |
| `data-transparency` | 0..1 | `0` | 本体の透明度(クリアジェル表現) |

### JS APIリファレンス

**コンストラクタ**

```js
var fx = new FluidSim(canvasOrSelector, {
  mode, colorA, colorB, viscosity, dyeDissipation, velocityDissipation,
  pressureIterations, viscosityIterations, splatRadius, speed,
  background, curlStrength, colorMode, displayMode, bloomStrength,
  displayParams: { specular, shininess, fresnel, transparency }
});
```

**メソッド**

| メソッド | 説明 |
| --- | --- |
| `setMode(mode)` | `'cursor'` \| `'ambient'` を切り替え |
| `setColors(colorA, colorB)` | 基準色A/Bをhexで設定 |
| `setViscosity(v)` | 粘度(0..1) |
| `setBackground(bg)` | `'dark'` \| `'light'` |
| `setDyeDissipation(v)` | 色の残留率(0..1) |
| `setVelocityDissipation(v)` | 速度の残留率(0..1) |
| `setPressureIterations(n)` | 圧力ヤコビ反復回数(10..80) |
| `setViscosityIterations(n)` | 粘性ヤコビ反復回数(0..50) |
| `setSplatRadius(v)` | 注入半径(0.01..1) |
| `setSpeed(v)` | シミュレーション速度(0.05..5) |
| `setCurlStrength(v)` | vorticity confinement強度(0..80) |
| `setColorMode(m)` | `'palette'` \| `'rainbow'` |
| `setDisplayMode(m)` | `'gloss'` \| `'ink'`(表示パイプライン切替) |
| `setBloomStrength(v)` | ブルーム強度(0..2、0で完全無効) |
| `setDisplayParams({specular, shininess, fresnel, transparency})` | 表示パラメータの部分更新 |
| `setParams(obj)` | 上記すべてのキーをまとめて一括更新(未知/未指定キーは無視、値は自動クランプ) |
| `splat(xNorm, yNorm, dxNorm, dyNorm)` | 任意位置に流体を注入(座標は0..1正規化) |
| `pause()` / `resume()` | 描画ループの一時停止 / 再開 |
| `destroy()` | イベントリスナー・GLリソースを解放して破棄 |

### デモページのクエリパラメータ

| パラメータ | 対象ページ | 説明 |
| --- | --- | --- |
| `?ui=1` (または `?ui=true`) | fluid.html / fluid-white.html / fluid-splash.html / fluid-ink.html / fluid-studio.html | 既定で非表示の設定パネル・キャプションを表示 |
| `?preset=serumDark\|serumWhite\|clear\|splash` | fluid-studio.html | プリセットを直接適用(`clearGel`も`clear`同様に受理) |
| `?overlay=0` | fluid-studio.html | LPオーバーレイ(見出し・CTA)を非表示 |
| 個別パラメータ上書き(例: `?viscosity=0.7&speed=1.2&curl=10&colorA=8a2438`) | fluid-studio.html | 「コピー」ボタンで出力されるJSONと同じキー名で個別上書き。`colorA`/`colorB`は`#`省略可。`curlStrength`は`curl`でも指定可 |

## プロジェクト構成

```
.
├── index.html          # トップページ(デモ一覧のランディングページ、アンビエント背景付き)
├── fluid-sim.js         # メインライブラリ: 格子流体シミュレーション(原液/美容液エフェクト)
├── fluid-studio.html    # 統合デモ: 全パラメータ調整UI + プリセット + LPオーバーレイ
├── fluid.html           # 単体デモ: ダーク背景の原液グロス表現
├── fluid-white.html     # 単体デモ: ホワイト背景 + 原液/クリアジェルプリセット
├── fluid-splash.html    # 単体デモ: 低粘性 + vorticity confinement + レインボー
├── fluid-ink.html       # 単体デモ: displayMode='ink' + ブルームのインクフロー(グロー)
├── embed-sample.html    # LP実装例(ヒーローセクションへの埋め込みパターン)
├── viscous-fluid.js     # ボーナス: 軽量メタボールベースの旧実装
├── metaball.html        # ボーナス: viscous-fluid.js を使った単体デモ
├── gold-shimmer.js      # スタンドアロンエフェクト: 金粉ラメシマー(GPUパーティクル)
├── gold-shimmer.html    # gold-shimmer.js の単体デモ
├── thin-film.js         # スタンドアロンエフェクト: 薄膜干渉パール
├── thin-film.html       # thin-film.js の単体デモ
├── water-caustics.js    # スタンドアロンエフェクト: 水面コースティクス
├── water-caustics.html  # water-caustics.js の単体デモ
├── water-ripple.js      # スタンドアロンエフェクト: 波動方程式リップル
├── water-ripple.html    # water-ripple.js の単体デモ
├── silk-cloth.js        # スタンドアロンエフェクト: シルクサテン
├── silk-cloth.html      # silk-cloth.js の単体デモ
├── LICENSE              # MITライセンス
└── README.md
```

## 技術メモ

- **パイプライン構成**: advect(移流) → viscosity(粘性拡散) → splat(注入) → divergence(発散) → pressure(圧力ヤコビ解) → project(圧力勾配減算) → dye advect(色移流) → display(表示シェーディング) → bloom(任意、有効時のみ: ダウンサンプル → 閾値抽出 → 2パス分離ブラー → 加算合成)
- **displayMode**: `gloss`(既定)は擬似法線 + スペキュラ + フレネルのグロス表現、`ink`はダイ色をそのまま(トーンカーブのみ)描画するフラットな発光表現。`bloomStrength=0`のときブルームパス自体を丸ごとスキップするため、`gloss`かつ`bloomStrength=0`の既存ページは変更前と出力が変わりません。
- half-float(`HALF_FLOAT`)のFBOでシミュレーション場を保持
- `OES_texture_float_linear` 非対応環境向けに手動バイリニアフィルタ(`bilerp`)へフォールバック
- `visibilitychange` で非表示タブ中は自動的に描画ループを一時停止
- devicePixelRatio(dpr)は上限2にクランプしてパフォーマンスを確保

## スタンドアロンエフェクト集

fluid-sim.js とは別系統の、単体WebGL2エフェクトライブラリ群です。依存ゼロ・`<script>` タグ1行、data-属性によるauto-init、`?ui=1`で調整パネル表示という共通の作法に揃えています。

### 共通: ポインター挙動オプション(全6ライブラリ共通)

fluid-sim.js を含む6つのライブラリすべてに、ポインター挙動を制御する共通オプションがあります。

| 属性 / オプション | 型 | デフォルト | 説明 |
| --- | --- | --- | --- |
| `data-pointer-trail` / `pointerTrail` | bool | `true` | `false`にすると、ポインター移動による軌跡(トレイル)が残らなくなる(その場の一時的な作用のみ) |
| `data-pointer-emit` / `pointerEmit` | `"move"` \| `"click"` | `move` | `click`にすると、ホバーだけでは反応せず、ポインターを押している間(pointerdown〜drag)だけ効果が発生する |

### 金粉ラメシマー(gold-shimmer.js)

GPUパーティクルの金粉フレークが緩やかな渦流に乗って漂い、個別に鋭い煌めき(ツインクル)を放つエフェクトです。全粒子の位置は頂点シェーダー側で`uTime`から解析的に導出され、CPU側のバッファ再構築は不要です。

```html
<canvas data-gold-shimmer
        data-mode="cursor"
        data-background="dark"
        style="position:absolute; inset:0; width:100%; height:100%; display:block;"></canvas>
<script src="gold-shimmer.js"></script>
```

| 属性 | 型 | デフォルト | 説明 |
| --- | --- | --- | --- |
| `data-mode` | `"cursor"` \| `"ambient"` | `cursor` | カーソル追従 / 自動アンビエント |
| `data-background` | `"dark"` \| `"light"` | `dark` | 加算合成(暗背景) / 通常合成(明背景)の切替 |
| `data-color-a` | hex color | `#d4af37` | 基準色A |
| `data-color-b` | hex color | `#fff3c4` | 基準色B |
| `data-particle-count` | 100..10000 | `3000` | 粒子数 |
| `data-speed` | 0.05..5 | `1` | 漂流速度 |
| `data-size` | 0.2..4 | `1` | 粒子サイズ係数 |
| `data-twinkle-rate` | 0..3 | `1` | 煌めきの頻度 |
| `data-swirl-strength` | 0..3 | `1` | 渦流の強さ |
| `data-pointer-trail` | bool | `true` | 共通オプション(上記参照) |
| `data-pointer-emit` | `"move"` \| `"click"` | `move` | 共通オプション(上記参照) |

### 薄膜干渉パール(thin-film.js)

シャボン膜や真珠層のような虹色の薄膜干渉を、ハッシュ値ノイズの厚みフィールド + コサインパレット近似で表現します。ポインターは膜の厚みに波紋(スタンプ)を刻みます。

```html
<canvas data-thin-film
        data-mode="cursor"
        data-background="light"
        style="position:absolute; inset:0; width:100%; height:100%; display:block;"></canvas>
<script src="thin-film.js"></script>
```

| 属性 | 型 | デフォルト | 説明 |
| --- | --- | --- | --- |
| `data-mode` | `"cursor"` \| `"ambient"` | `cursor` | カーソル追従 / 自動アンビエント |
| `data-background` | `"dark"` \| `"light"` | `light` | 表示シェーディングのプロファイル |
| `data-color-a` | hex color | `#f6f2ee` | 基準色A |
| `data-color-b` | hex color | `#dcc8e8` | 基準色B |
| `data-hue-shift` | 0..1 | `0` | パレット位相の回転 |
| `data-intensity` | 0..1 | `0.6` | 虹色の強さ(0は素のパール調グラデーション) |
| `data-scale` | 0.2..12 | `3.2` | 干渉バンドの周波数 |
| `data-flow-speed` | 0..4 | `1` | 厚みフィールドの流動速度 |
| `data-ripple-strength` | 0..3 | `1` | ポインター波紋の強さ |
| `data-opaque` | bool | `true` | 不透明表示するか |
| `data-pointer-trail` | bool | `true` | 共通オプション(上記参照) |
| `data-pointer-emit` | `"move"` \| `"click"` | `move` | 共通オプション(上記参照) |

### 水面コースティクス(water-caustics.js)

方向性サイン波 + ハッシュノイズで構成した水面の高さフィールドから、屈折光のスクリーンスペースヤコビアンでコースティクス(光の網目)を推定するエフェクトです。カーソルモードではポインター操作でその場に広がる減衰リング波紋が生成されます。

```html
<canvas data-water-caustics
        data-mode="cursor"
        data-background="light"
        data-color-a="#bfe6e4"
        data-color-b="#4f9ea8"
        style="position:absolute; inset:0; width:100%; height:100%; display:block;"></canvas>
<script src="water-caustics.js"></script>
```

| 属性 | 型 | デフォルト | 説明 |
| --- | --- | --- | --- |
| `data-mode` | `"cursor"` \| `"ambient"` | `cursor` | カーソル追従(波紋リング生成) / 自動アンビエント |
| `data-background` | `"dark"` \| `"light"` | `light` | 夜の深いプール / 明るいスパ、の配色プロファイル |
| `data-color-a` | hex color | `#bfe6e4` | 基準色A |
| `data-color-b` | hex color | `#4f9ea8` | 基準色B |
| `data-wave-height` | 0..1 | `0.45` | 波の高さ |
| `data-wave-speed` | 0.1..3 | `0.6` | 波の速度 |
| `data-caustic-strength` | 0..3 | `1.1` | コースティクスの強さ |
| `data-caustic-scale` | 0.3..4 | `1.3` | コースティクスの網目スケール |
| `data-chromatic` | 0..1 | `0.35` | 色収差風の分散 |
| `data-ray-strength` | 0..1 | `0.12` | 光条(ゴッドレイ)の強さ |
| `data-ripple-strength` | 0..2 | `1.35` | ポインター波紋の強さ |
| `data-pointer-trail` | bool | `true` | 共通オプション(上記参照) |
| `data-pointer-emit` | `"move"` \| `"click"` | `move` | 共通オプション(上記参照) |

### 波動方程式リップル(water-ripple.js)

水面コースティクスの疑似ウェーブとは異なり、グリッド上で実際に2D波動方程式を毎フレーム解く(verlet形式の陽的差分スキーム: `h_new = damping * (2*h - h_prev + c^2 * laplacian(h))`)ことで、干渉・端での反射・自然な減衰がすべて計算から自然に生まれる、本物に近い波紋を表現します。境界はテクスチャの`CLAMP_TO_EDGE`によって自然に閉じた水槽のように反射します。滴はガウス型の窪みとして高さフィールドに注入され、表示パスは高さの勾配から法線を求めて背景を屈折させ、スペキュラの照り返しを加えます。

背景は既定では手続き型グラデーションですが、`imageSrc`(URL)/`image`(`HTMLImageElement`または`HTMLCanvasElement`)を指定すると実画像を波面が屈折する、jquery.ripples風の「写真の上の波紋」表現になります。画像は**cover-fit**(アスペクト比を保ったまま、はみ出た部分をクロップしてキャンバス全体を覆う。CSSの`background-size: cover`と同じ考え方)でマッピングされ、リサイズ時に自動で再計算されます。

```html
<canvas data-water-ripple
        data-mode="cursor"
        data-background="light"
        data-color-a="#bfe6e4"
        data-color-b="#4f9ea8"
        data-image-src="photo.jpg"
        style="position:absolute; inset:0; width:100%; height:100%; display:block;"></canvas>
<script src="water-ripple.js"></script>
```

| 属性 | 型 | デフォルト | 説明 |
| --- | --- | --- | --- |
| `data-mode` | `"cursor"` \| `"ambient"` | `cursor` | カーソル追従(滴を注入) / 自動アンビエント(1〜3秒毎にランダムな滴) |
| `data-background` | `"light"` \| `"dark"` | `light` | 屈折させる背景グラデーションの配色プロファイル(画像背景時は無視) |
| `data-color-a` | hex color | `#bfe6e4` | 基準色A(画像背景時は無視) |
| `data-color-b` | hex color | `#4f9ea8` | 基準色B(画像背景時は無視) |
| `data-damping` | 0.9..0.999 | `0.985` | 減衰(波が収まる速さ。1に近いほど長く残る) |
| `data-wave-speed` | 0.05..0.5 | `0.3` | 伝播速度(差分スキームのc^2、安定性のため内部で0.5にクランプ) |
| `data-drop-strength` | 0..3 | `1.0` | 滴の強さ |
| `data-drop-radius` | 0.002..0.1 | `0.015` | 滴の半径(正規化座標) |
| `data-refraction` | 0..3 | `1.0` | 屈折の強さ |
| `data-specular` | 0..3 | `1.0` | ツヤ(スペキュラ)の強さ |
| `data-tile-pattern` | bool | `false` | 背景に薄い床タイル模様を重ねるか(画像背景時は無視) |
| `data-pointer-trail` | bool | `true` | 共通オプション(上記参照) |
| `data-pointer-emit` | `"move"` \| `"click"` | `move` | 共通オプション(上記参照) |
| `data-image-src` | URL文字列 | なし | 波面が屈折する背景画像。非同期読み込み中/失敗時は手続き型グラデーションを維持(cover-fitでマッピング) |

`drop(xNorm, yNorm, strength)` メソッドで任意位置に正規化座標(0..1)で滴を直接注入できます。`setImage(srcOrElement | null)` メソッドで背景画像を実行時に差し替え(URL文字列 / `HTMLImageElement` / `HTMLCanvasElement` を受け付け、`null`で手続き型グラデーションに戻す)できます。

### シルクサテン(silk-cloth.js)

ドメインワープされた値ノイズで作った布の「折り目」高さフィールドを異方性(Ward/Kajiya-Kay系)スペキュラで照らし、サテン地特有の帯状ハイライトを表現します。カーソルモードではポインターで布をやさしく押し込めます。

```html
<canvas data-silk-cloth
        data-mode="cursor"
        data-color-a="#c9a86c"
        data-color-b="#6d4f2f"
        style="position:absolute; inset:0; width:100%; height:100%; display:block;"></canvas>
<script src="silk-cloth.js"></script>
```

| 属性 | 型 | デフォルト | 説明 |
| --- | --- | --- | --- |
| `data-mode` | `"cursor"` \| `"ambient"` | `cursor` | カーソル追従(押し込み) / 自動アンビエント |
| `data-background` | `"dark"` \| `"light"` | `dark` | 表示シェーディングのプロファイル |
| `data-color-a` | hex color | `#c9a86c` | 基準色A |
| `data-color-b` | hex color | `#6d4f2f` | 基準色B |
| `data-sheen-color` | hex color | `#fff8f0` | 光沢(シーン)の色 |
| `data-fold-scale` | 0.2..8 | `2.2` | 折り目の細かさ |
| `data-fold-depth` | 0..2 | `0.9` | 折り目の深さ |
| `data-fold-direction` | degrees(0..360) | `25` | 折り目の方向 |
| `data-flow-speed` | 0..4 | `0.5` | 折り目の流動速度 |
| `data-sheen-strength` | 0..3 | `1.1` | 光沢の強さ |
| `data-shininess` | 1..400 | `90` | 光沢の鋭さ |
| `data-anisotropy` | 0..1 | `0.85` | 異方性の強さ |
| `data-press-strength` | 0..3 | `0.35` | ポインター押し込みの強さ |
| `data-pointer-trail` | bool | `true` | 共通オプション(上記参照) |
| `data-pointer-emit` | `"move"` \| `"click"` | `move` | 共通オプション(上記参照) |

## ライセンス

MIT License © 2026 ymb
