# Veil — Design System

## Aesthetic
Dark terminal. No gradients. No glow. Minimal border radius. Monospace throughout.
Inspired by trading terminals and privacy tooling — functional, legible, sharp.

## Colors
| Token             | Value     | Usage                        |
|-------------------|-----------|------------------------------|
| `--bg`            | `#0a0a0a` | Page background              |
| `--surface`       | `#141414` | Cards, panels                |
| `--border`        | `#1f1f1f` | Separators, outlines         |
| `--text`          | `#e0e0e0` | Primary text                 |
| `--text-secondary`| `#808080` | Labels, captions             |
| `--accent`        | `#00ff88` | Success, anonymous state     |
| `--warning`       | `#ffaa00` | Nearing threshold            |
| `--danger`        | `#ff4444` | Frozen / error state         |

## Typography
- **Font**: JetBrains Mono (Google Fonts) — all weights, all sizes
- **Base size**: 14px
- **Line height**: 1.6 (body), 1 (headings)
- **Letter spacing**: 0.04–0.15em on headings, minimal on body

## Spacing
- Base unit: 4px (`--spacing-1`)
- Scale: 4, 8, 12, 16, 24, 32, 48, 64px
- All padding and margin values are multiples of 4px

## Shape
- Border radius: `2px` maximum (`--radius`) — sharp, terminal feel
- No pill buttons, no large rounded cards

## Components

### Cards
- Background: `var(--surface)`
- Border: `1px solid var(--border)`
- Radius: `2px`
- Accent line: `2px` top edge in `var(--accent)`

### Buttons
- Outlined by default: `1px solid var(--accent)`, transparent fill
- Hover: fill with `var(--accent)`, text becomes `var(--bg)`
- Uppercase, letter-spacing 0.08em
- No drop-shadow

### Status indicators
- Anonymous: `var(--accent)` (#00ff88)
- Warning / near threshold: `var(--warning)` (#ffaa00)
- Frozen / KYC required: `var(--danger)` (#ff4444)

## Do NOT
- Use gradients or glow effects
- Use border-radius > 2px on interactive elements
- Use any font other than JetBrains Mono
- Use box-shadow for decorative purposes
- Import UI component libraries (shadcn, MUI, etc.) — hand-craft all components
