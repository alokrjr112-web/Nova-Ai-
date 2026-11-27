// Nova AI — chat client. Conversation lives in this tab; the server is stateless.
const $ = (id) => document.getElementById(id);
const chatEl = $("chat"), emptyEl = $("empty"), form = $("composer"), input = $("input");
const sendBtn = $("send"), filesInput = $("files"), attachEl = $("attachments");
const modelSel = $("model"), reasoningSel = $("reasoning");

const MAX_TEXT_CHARS = 30000;   // same truncation as the original app
const MAX_IMAGE_SIDE = 1536;
const MAX_FILES = 6;

let history = [];        // [{role, content}] in OpenAI chat format
let pending = [];        // attachments for the next message
let controller = null;   // AbortController for the in-flight request
let models = [];

// ---------- settings ----------
for (const [id, out, digits] of [["temperature", "temperatureOut", 2], ["topP", "topPOut", 2], ["topK", "topKOut", 0]]) {
  const el = $(id);
  const sync = () => ($(out).textContent = Number(el.value).toFixed(digits));
  el.addEventListener("input", sync); sync();
}
$("settingsBtn").addEventListener("click", (e) => {
  const s = $("settings"); s.hidden = !s.hidden;
  e.currentTarget.setAttribute("aria-expanded", String(!s.hidden));
});
function syncModelUi() {
  const m = models.find((x) => x.id === modelSel.value);
  reasoningSel.disabled = m ? !m.reasoning : false;
}
modelSel.addEventListener("change", syncModelUi);

fetch("/api/models").then((r) => r.json()).then((data) => {
  models = data.models;
  modelSel.innerHTML = models.map((m) => `<option value="${m.id}">${m.label}</option>`).join("");
  modelSel.value = data.default;
  syncModelUi();
}).catch(() => {
  modelSel.innerHTML = `<option value="qwen/qwen3.8-27b">Qwen3.8 27B</option>`;
});

$("newChat").addEventListener("click", () => {
  controller?.abort();
  history = []; pending = []; renderAttachments();
  chatEl.querySelectorAll(".msg").forEach((n) => n.remove());
  emptyEl.hidden = false; input.focus();
});

// ---------- attachments ----------
const loadImage = (file) => new Promise((resolve, reject) => {
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
  img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("decode")); };
  img.src = url;
});

// Re-encode every image (any format the browser can decode) to a bounded JPEG/PNG data URL.
async function imageToDataUrl(file) {
  const img = await loadImage(file);
  const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
  canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
  const type = file.type === "image/png" || file.type === "image/gif" ? "image/png" : "image/jpeg";
  return canvas.toDataURL(type, 0.9);
}

async function looksLikeText(file) {
  if (file.type.startsWith("text/") || /json|xml|javascript|yaml|csv|markdown/.test(file.type)) return true;
  const head = new Uint8Array(await file.slice(0, 4096).arrayBuffer());
  return !head.includes(0);
}

async function addFiles(fileList) {
  for (const file of fileList) {
    if (pending.length >= MAX_FILES) { flash(`Up to ${MAX_FILES} attachments per message.`); break; }
    try {
      if (file.type.startsWith("image/") || /\.(heic|heif|tiff?|bmp)$/i.test(file.name)) {
        pending.push({ kind: "image", name: file.name, url: await imageToDataUrl(file) });
      } else if (await looksLikeText(file)) {
        let text = await file.text();
        if (text.length > MAX_TEXT_CHARS) text = text.slice(0, MAX_TEXT_CHARS) + "\n…[truncated]";
        pending.push({ kind: "text", name: file.name, text });
      } else {
        flash(`“${file.name}” isn't an image or text file.`);
      }
    } catch {
      flash(`Couldn't read “${file.name}” — this browser can't decode that format. Try JPEG or PNG.`);
    }
  }
  renderAttachments();
}

function renderAttachments() {
  attachEl.innerHTML = "";
  pending.forEach((a, i) => {
    const chip = document.createElement("div");
    chip.className = "chip";
    if (a.kind === "image") { const im = document.createElement("img"); im.src = a.url; im.alt = ""; chip.append(im); }
    chip.append(document.createTextNode(a.name));
    const x = document.createElement("button");
    x.type = "button"; x.textContent = "×"; x.setAttribute("aria-label", `Remove ${a.name}`);
    x.onclick = () => { pending.splice(i, 1); renderAttachments(); };
    chip.append(x);
    attachEl.append(chip);
  });
}

filesInput.addEventListener("change", () => { addFiles([...filesInput.files]); filesInput.value = ""; });
input.addEventListener("paste", (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) { e.preventDefault(); addFiles(files); }
});
form.addEventListener("dragover", (e) => { e.preventDefault(); form.classList.add("drag"); });
form.addEventListener("dragleave", () => form.classList.remove("drag"));
form.addEventListener("drop", (e) => { e.preventDefault(); form.classList.remove("drag"); addFiles([...e.dataTransfer.files]); });

// ---------- markdown (escaped first, so model output can't inject HTML) ----------
const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function inline(s) {
  return s
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
}
function markdown(src) {
  const blocks = [];
  let text = esc(src).replace(/```([\w+-]*)\n?([\s\S]*?)(```|$)/g, (_, lang, code) => {
    blocks.push(`<pre><code${lang ? ` data-lang="${lang}"` : ""}>${code.replace(/\n$/, "")}</code></pre>`);
    return `\u0000${blocks.length - 1}\u0000`;
  });
  const out = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\u0000\d+\u0000$/.test(line.trim())) { out.push(line.trim()); continue; }
    let m;
    if ((m = line.match(/^(#{1,4})\s+(.*)/))) { out.push(`<h${m[1].length + 1}>${inline(m[2])}</h${m[1].length + 1}>`); continue; }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const items = [];
      while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) items.push(`<li>${inline(lines[i++].replace(/^\s*([-*+]|\d+[.)])\s+/, ""))}</li>`);
      i--; out.push(`<${ordered ? "ol" : "ul"}>${items.join("")}</${ordered ? "ol" : "ul"}>`); continue;
    }
    if (/^\|.*\|\s*$/.test(line) && /^\|[\s:|-]+\|\s*$/.test(lines[i + 1] || "")) {
      const cells = (l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => inline(c.trim()));
      const head = cells(line); i += 2; const rows = [];
      while (i < lines.length && /^\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
      i--;
      out.push(`<table><tr>${head.map((c) => `<th>${c}</th>`).join("")}</tr>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</table>`);
      continue;
    }
    if ((m = line.match(/^&gt;\s?(.*)/))) { out.push(`<blockquote>${inline(m[1])}</blockquote>`); continue; }
    if (!line.trim()) { out.push(""); continue; }
    const para = [line];
    while (i + 1 < lines.length && lines[i + 1].trim() && !/^(#{1,4}\s|\s*([-*+]|\d+[.)])\s|&gt;|\||\u0000)/.test(lines[i + 1])) para.push(lines[++i]);
    out.push(`<p>${inline(para.join("<br>"))}</p>`);
  }
  return out.join("\n").replace(/\u0000(\d+)\u0000/g, (_, n) => blocks[n]);
}

// ---------- rendering ----------
function addMessage(role) {
  emptyEl.hidden = true;
  const wrap = document.createElement("div");
  wrap.className = `msg ${role}`;
  chatEl.append(wrap);
  return wrap;
}
const scrollDown = () => (chatEl.scrollTop = chatEl.scrollHeight);
function flash(text) {
  const n = addMessage("assistant");
  n.innerHTML = `<p class="note error"></p>`; n.firstChild.textContent = text; scrollDown();
}

function renderUser(text, atts) {
  const wrap = addMessage("user");
  const imgs = atts.filter((a) => a.kind === "image");
  if (imgs.length) {
    const t = document.createElement("div"); t.className = "thumbs";
    imgs.forEach((a) => { const im = document.createElement("img"); im.src = a.url; im.alt = a.name; t.append(im); });
    wrap.append(t);
  }
  atts.filter((a) => a.kind === "text").forEach((a) => {
    const f = document.createElement("span"); f.className = "filetag"; f.textContent = `📄 ${a.name}`; wrap.append(f);
  });
  if (text) { const b = document.createElement("div"); b.className = "bubble"; b.textContent = text; wrap.append(b); }
  scrollDown();
}

function buildContent(text, atts) {
  const docs = atts.filter((a) => a.kind === "text").map((a) => `<file name="${a.name}">\n${a.text}\n</file>`);
  const fullText = [...docs, text].filter(Boolean).join("\n\n");
  const imgs = atts.filter((a) => a.kind === "image");
  if (!imgs.length) return fullText;
  return [...imgs.map((a) => ({ type: "image_url", image_url: { url: a.url } })), ...(fullText ? [{ type: "text", text: fullText }] : [])];
}

// ---------- sending ----------
function setBusy(busy) {
  sendBtn.classList.toggle("stop", busy);
  sendBtn.textContent = busy ? "■" : "↑";
  sendBtn.setAttribute("aria-label", busy ? "Stop" : "Send");
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (controller) { controller.abort(); return; }
  const text = input.value.trim();
  if (!text && !pending.length) return;
  const atts = pending; pending = []; renderAttachments();
  input.value = ""; autosize();

  renderUser(text, atts);
  history.push({ role: "user", content: buildContent(text, atts) });

  const wrap = addMessage("assistant");
  const bubble = document.createElement("div"); bubble.className = "bubble cursor"; wrap.append(bubble);
  let thinking = "", answer = "", thinkEl = null, truncated = false, failed = null;

  controller = new AbortController(); setBusy(true);
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        messages: history,
        model: modelSel.value,
        reasoning: reasoningSel.value,
        temperature: Number($("temperature").value),
        top_p: Number($("topP").value),
        top_k: Number($("topK").value),
      }),
    });
    if (!res.ok || !res.body) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `Request failed (${res.status})`);
    }
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        const ev = JSON.parse(line);
        if (ev.type === "think") {
          thinking += ev.text;
          if (!thinkEl) {
            thinkEl = document.createElement("details"); thinkEl.className = "thinking"; thinkEl.open = true;
            thinkEl.innerHTML = "<summary>Thinking…</summary><div></div>"; wrap.insertBefore(thinkEl, bubble);
          }
          thinkEl.lastChild.textContent = thinking;
        } else if (ev.type === "text") {
          answer += ev.text;
          if (thinkEl && answer === ev.text) { thinkEl.open = false; thinkEl.firstChild.textContent = "Reasoning"; }
          bubble.innerHTML = markdown(answer);
        } else if (ev.type === "done") {
          truncated = ev.truncated;
        } else if (ev.type === "error") {
          failed = ev.message;
        }
        scrollDown();
      }
    }
  } catch (err) {
    if (err.name !== "AbortError") failed = err.message || "Something went wrong.";
  } finally {
    controller = null; setBusy(false); bubble.classList.remove("cursor");
  }

  if (thinkEl) thinkEl.firstChild.textContent = "Reasoning";
  if (answer) history.push({ role: "assistant", content: answer });
  else if (!failed) bubble.innerHTML = `<p class="note">${thinking ? "No answer — the reply budget was spent on reasoning. Lower the reasoning effort and try again." : "(no reply)"}</p>`;
  if (truncated && answer) wrap.insertAdjacentHTML("beforeend", `<p class="note">Reply reached the 1024-token limit and was cut off. Ask it to continue.</p>`);
  if (failed) {
    const n = document.createElement("p"); n.className = "note error"; n.textContent = failed; wrap.append(n);
    if (!answer) history.pop(); // drop the unanswered user turn so a retry doesn't duplicate it
  }
  scrollDown();
});

input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); }
});
function autosize() { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 220) + "px"; }
input.addEventListener("input", autosize);
input.focus();
