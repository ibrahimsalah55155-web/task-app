# Reference 01 — vertical podcast reel (Atheer style)

Source: video sent by the editor, 1080×1920, 25 fps, 75.3 s. Analysed frame by frame
(25 fps strips) on 2026-11-12. Frame numbers below are at 25 fps (frame 100 = 4.00 s).
Brand assets in the reference (Atheer and partner logos, the flower icon, the outro
logo) are **not** reproduced; the plugin uses the user's own logo and icon in those slots.

## Palette (sampled)

| Token | Value | Use |
|---|---|---|
| `accent` | `#EC797B` (236,121,123) | guest caption pill, icon disc, highlights |
| `ink` | `#FFFFFF` | text on dark / on accent |
| `paper` | `#F4F5F7` (white pill) | host caption pill |
| `paper-ink` | `#1B2340` (dark navy) | text on white pill |
| `panel` | `#0B213C` (11,33,60) @ ~85 % | title card panel |
| `icon-dots` | `#2B2F7A` (indigo) | dots inside the icon disc |

Type: one geometric Arabic sans family, two weights (Bold for names/titles/captions,
Regular for subtitles). Exact font unknown; to be confirmed by the editor.

## 1. Speaker captions (pill)

- Short phrases of 2–5 words; one line; replaced instantly on the next phrase (hard cut,
  no animation, measured frames 60→61).
- **Colour shows who speaks:** host = white pill with dark navy text; guest = coral pill
  with white text.
- Size: text cap height ≈ 26 px on 1080 width; pill padding ≈ 10 px × 6 px; corner radius ≈ 8 px.
- Position: horizontally centred on the speaker's body, at chest height (≈ 56–60 % of frame
  height in single shots); sits on the seam line in split screen (see 5).

## 2. Title card (key statement)

Seen 2.8–6.2 s: «اجعل الجدة / جزءًا من حياتك».
- Panel: dark navy rounded rectangle (~76 % frame width, ~22 % height, radius ≈ 12 px),
  semi-transparent, with a texture of thin **vertical light stripes** (glass/blinds look).
- Above the text, centred: the accent icon disc (≈ 44 px).
- Text: two lines, Bold, ≈ 64 px, white, centred, line spacing ≈ 1.15.
- In (frames ~69–86, 0.7 s): panel and icon rise from below with the stripe texture moving
  across them, then settle (ease-out).
- Hold ≈ 2.5 s while the speaker captions keep running above it.
- Out (frames ~148–160, 0.5 s): text and panel break up through the vertical stripes
  (blinds / scan-line dissolve) and fade.

## 3. Lower third (guest name)

Seen 8.4–14.2 s: «د.هبة حريري / أخصائية علاج نفسي وإرشاد تربوي».
- Layout (RTL): accent icon disc on the right (centre ≈ x 910, y 1430); name Bold ≈ 44 px
  right-aligned to x ≈ 850 above a 2 px white line; title Regular ≈ 28 px below the line.
  Line runs from x ≈ 340 to x ≈ 850.
- In, two beats:
  1. frames 210–233 (≈ 0.95 s): the icon travels from the left edge to its final place,
     drawing the white line behind it; strong ease-out (fast start, long settle).
  2. frames 233–255 (≈ 0.9 s): name and title are revealed **from right to left**, starting
     at the icon (mask wipe following the Arabic reading direction); title starts ~3 frames
     after the name.
- Hold ≈ 3 s.
- Out (12.6–14.2 s): reverse: text wipes away towards the icon, line retracts, icon leaves.

## 4. Emphasis words (no box)

Seen 46 s «نوفر لها وقتًا», 67–68 s «أنشطة جماعية».
- Large Bold white text (≈ 56 px), centred over the speaker, no background, soft shadow.
- In: typed **word-by-word / letter group** from right to left (half the phrase visible at
  67 s, full at 68 s), ≈ 1 s total. Out: cut.

## 5. Split screen (guest top / host bottom)

Seen 21–40 s and 40.0 s.
- 50/50 vertical split; guest on top, host bottom; each shot reframed to fill 1080×960.
- The caption pill sits on the seam, with the icon disc at the left end and a thin line across
  the seam.
- In: at 20 s a zoom-blur push from the single shot into the split. Out at 40–41 s: soft
  blur/flash back to a single shot.

## 6. Call-to-action strip

Seen 52–59 s: «تابع الحلقة كاملة على يوتيوب».
- Small navy rounded pill (≈ 60 % width) with white text and a YouTube glyph inside an accent
  disc on the right; placed just under the caption.
- In (frames ~1300–1320): the icon disc pops in, then the pill extends to the left.

## 7. Punch-ins and outro

- Punch-in zooms (≈ 115–125 %) on emphasis beats (e.g. 52 s): hard cut between framings.
- Outro (71–75 s): blurred cross-dissolve into a blue gradient with moving vertical light
  streaks, logo + tagline centred. To be rebuilt with the editor's own logo.

## Build plan in the plugin

| Element | Delivery in Premiere 27 | Editable |
|---|---|---|
| Speaker captions | Phase 6 captions engine, two styles (host/guest) chosen by Auto Director speaker data | text, timing, style |
| Title card, lower third, emphasis words, CTA | MOGRT templates inserted at the playhead (`insertMogrtFromPath`); text set with `MogrtText` (27.0) | text, colours, durations |
| Split screen | Built from the real camera tracks (Motion + Crop), not a flattened render | framing per camera |
| Punch-ins | Motion scale keyframes on the cut pieces | yes |
| Outro | MOGRT with the editor's logo | logo, tagline |
