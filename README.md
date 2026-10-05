# ⚡ CodeSolve AI — Page Chat

A Chrome extension (Manifest V3) that puts a **floating chatbot on every page**.
It reads the page for you — questions, tasks, MCQ options, error messages, task
descriptions, and the code in any editor on the page — so you never have to
copy-paste. Just select something (or not) and ask; answers stream in instantly
from **Groq**, with complete working code in the language already in play
(normal coding problems, **code-repo / build-style tasks**, debugging, MCQs…).

## The chatbot

- **Always present** on every site — it survives SPA navigations and page re-renders.
- **Drag** it anywhere by its header, **resize** it from the corner grip.
  Position, size, and minimized state persist across pages and sessions.
- **Minimize** (—) to a small ⚡ bubble; click it to reopen.
- The toolbar popup's **Show on all pages** toggle hides/shows it everywhere;
  right-click → **"Ask CodeSolve about this selection"** opens it pre-filled.

## Page awareness — no copy-pasting

Every question automatically carries PAGE CONTEXT to the model:

- Page **title + URL**
- **Multiple labeled regions** extracted from the page — the question/task
  description, a README or doc preview, the repo **file tree**, and other
  content areas (this is what makes **code-repo style challenges** work: the
  chatbot reads the question and README, sees the repo structure, and suggests
  which files to inspect)
- Your **current text selection** (highest priority — select an error, an
  option, or a paragraph and just ask about it)
- The **code editor's content** — the file you have open — with its
  **auto-detected language** (CodeMirror 5/6, Monaco, ACE, plain
  textareas/contenteditables)
- **Embedded panels too**: content is collected from every frame of the page
  (assessment IDEs like HackerRank's test-v2 render the question, README
  viewer, file tree and code editor inside iframes — the chatbot reads all of
  them and merges the results, labeled by frame)

The chat prompt makes the model answer about the page specifically, handle
pages with **several questions** (always answering about the currently open
one), work through **code-repo tasks** (question → README → which files to
inspect → complete paste-ready fixes), and match the language of your pasted
code / editor. Anything you paste into the chat is treated as part of the
question.

## Quick chips (inside the chat)

| Chip | What it does |
|---|---|
| 🚀 Solve this problem | Rigorous flow: extract problem → detect language → solve → self-check pass (traces every sample, fixes bugs) → answer with code |
| Explain this page | What the page/task is asking and a good approach |
| Review my code | Bugs, edge cases, and complexity of the editor/page code |

## Code answers

Answers render with a language label and two actions:

- **Copy** — clipboard, one click.
- **⌨️ Type** — types the code into the page's editor **character-by-character
  with human cadence** (jittered delays, punctuation pauses, optional typos with
  Backspace corrections, per-line indentation normalization). Progress shows
  inline with a Stop button; afterwards the editor is read back and verified.
  Monaco sites (like LeetCode) are driven through a MAIN-world bridge that uses
  Monaco's own `type` command, since they ignore synthetic edits.

## Invisible to the other side during screen sharing

The chatbot is built to be **visible to you but invisible in what you share**:

| How you share | What the other person sees |
|---|---|
| Share **this tab** (Meet's default) | The chatbot's region is **cut out of the shared video automatically** (Element Capture "exclude") — it stays on your screen, and it also stays cut out while you drag it around. |
| Share **another tab** | Nothing of this page is shared — chatbot invisible. |
| Share **a window** (in-page chat) | Chatbot hides until the share ends. Click **🪟 Float** first instead: the chat moves to a private always-on-top window, which window sharing **cannot** capture — visible only to you. |
| Share **entire screen** | Chatbot hides until the share ends. Even floated, an entire-screen share captures every pixel of the display — no browser technology can exclude anything from it. **Share the tab or window instead of the whole screen.** |
| Native OS recorders (OBS, Game Bar, desktop Zoom app…) | Cannot be detected by any browser extension; nothing on the display can be hidden from them. |

**🪟 Float mode**: click the 🪟 button in the chat header to move the chat into
its own private always-on-top mini-window (Document Picture-in-Picture). It
floats over Meet, stays on top while you work, and tab/window sharing never
captures it. Click 🪟 again (or the window's ✕) to bring the chat back to the
page; minimize while floated returns it to the page minimized. When a
window/full-screen capture starts, the private window closes automatically and
the chat reappears on the page (hidden) once the capture ends.

**Dual monitors**: the in-page chatbot is web content and can never leave the
browser window — but the 🪟 floated chat is a real OS window, so it can live on
any monitor. Drag it to your second screen, or click the **⇄** button (shown
while floated on multi-monitor setups) to jump it to the other display.
Note: if that screen is being shared via "entire screen", the window closes for
the duration, as with any capture.

## Install (Load unpacked)

1. Open `chrome://extensions` in Chrome (or Edge/Brave).
2. Turn on **Developer mode** (top-right).
3. Click **Load unpacked** and select this folder (`Code-Solve-Extension`).
4. The ⚡ chatbot appears on the page. Pin the toolbar icon for the popup.

> Chrome shows a broad "read and change all your data on all websites" warning —
> that is what makes the chatbot present on every page with full page access.

## Settings (toolbar popup → Options)

| Setting | Meaning |
|---|---|
| API key | Your Groq key (free at [console.groq.com/keys](https://console.groq.com/keys)). **Required before first use** — enter it once in Options; it is stored only in your browser (`chrome.storage.local`) and never in the source code. **Test** verifies it live. |
| Model | Default `openai/gpt-oss-120b` with automatic fallbacks (`qwen/qwen3.8-27b`, `openai/gpt-oss-20b` — verified against this Groq account). |
| Typing speed | Slow / Normal / Fast — used by the ⌨️ Type action. |
| Human typos + fixes | Occasional typo + Backspace correction while typing. |
| Self-check pass | The verification pass used by the Solve chip. |
| Default language | Used when no language can be detected. |
| Show the chatbot on all pages | Master on/off for the floating widget. |

## Dev tests

```
node --check *.js                    # syntax
dev-tests/test_api.mjs               # live solve+verify round-trip (writes generated_solution.py)
python dev-tests/assert_solution.py  # executes the generated solution against samples
python -m http.server 8899 --directory dev-tests
                                     # open http://localhost:8899/mock-site.html
                                     # mock problem page with a CodeMirror-6-like editor
                                     # (?editor=mini&autoindent=1 forces the offline editor
                                     #  with Monaco-style Enter auto-indent)
```

## 🔑 API key setup

- **No API key ships with the source code** — committing one would expose it
  (GitHub's push protection blocks such pushes), and anyone using the repo
  needs their own free key.
- Get a free key at [console.groq.com/keys](https://console.groq.com/keys),
  open the extension **Options**, paste it, press **Test**, then **Save**.
  It is stored only in your browser (`chrome.storage.local`).
- Never share your key; if it ever leaks, rotate it at
  [console.groq.com/keys](https://console.groq.com/keys).

## Files

```
manifest.json     MV3 manifest (all-sites content script, permissions)
config.js         defaults, prompts (page-aware chat, solve, verify), model list
background.js     Groq streaming client (Port), solve + self-check, key test,
                  Monaco-bridge injection, capture-state coordination, context menus
typer.js          editor adapters + human-like typing engine
monaco-bridge.js  MAIN-world helper: drives Monaco via its own type command
capture-hook.js   MAIN-world hook: detects browser screen share/recording and
                  excludes the chatbot's region from tab captures (all frames)
content.js        the floating chatbot: drag/resize/persist, page-context
                  builder, streaming chat, code blocks, type-into-editor,
                  🪟 private float window, share-exclusion/auto-hide logic
popup.html/js     show/hide chatbot, open chat here, options
options.html/js   full settings with live key test
dev-tests/        mock problem page + live API test + typed-solution artifacts
make_icons.py     regenerates icons/ PNGs
```

## Troubleshooting

- **Chatbot doesn't appear** — check *Show on all pages* in the popup; reload the
  page after (re)installing. On `chrome://` pages browsers don't allow extensions.
- **"No code editor found"** — the page has no editor; use Copy instead.
- **"Rate limit reached"** — free-tier Groq limits; wait a minute or switch models.
- **Wrong text extracted** — select the right part of the page and ask; the
  selection always wins.
