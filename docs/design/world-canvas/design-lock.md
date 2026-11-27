# World canvas design lock

- Primary: the existing Arcanea whiteboard look: near-black stage #09090b, color lives in the world imagery and region tints, not in chrome.
- Structure from fal.ai workflows and Weavy (Refero screens f11037fe, 1787c838): dotted infinite canvas, top bar with world title and view switch, right inspector sidebar, bottom floating toolbar (select, pan, add node, link, zoom, fit).
- Graph exploration from Memotron (Refero a651d4c1): Graph / Timeline / Map view switch and a depth control for neighborhood focus.
- Atmosphere from Shader and BitcoinOS styles (Refero 156fc893, 48eb2b91): cinematic world scenes, one warm gold accent (#e7b844-family) reserved for selection and canon badges only, literary serif for node titles at full zoom, clean grotesk for UI.
- Reject: neon gradients, glassmorphism everywhere, purple-blue AI glow, emoji icons, more than one accent color, cramped cards, text inside images.
- Tokens: bg #09090b, surface #121216, line rgba(255,255,255,.08), text #ededf0, muted #8b8b95, accent gold for selection/canon only; region tints at 6-10% opacity; radius 10; 8px spacing grid.
