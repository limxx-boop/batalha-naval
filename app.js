"use strict";
/* Batalha Naval — Mini App do Telegram */

const tg = window.Telegram && window.Telegram.WebApp;
const LETRAS = "ABCDEFGHIJ";
const TAM = 10;

const S = {
  estado: null, recebidoEm: 0,
  ws: null, url: null, partida: null, fatal: false, tentativas: 0,
  editor: null, enviando: false, demo: null,
};

// ---------------------------------------------------------------- utilidades
const $ = (s) => document.querySelector(s);
const esc = (t) => String(t ?? "").replace(/[&<>"']/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const coord = (x, y) => LETRAS[x] + (y + 1);

let _toastTimer = null;
function toast(msg, tipo) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast ver" + (tipo === "erro" ? " erro" : "");
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => (t.className = "toast"), 2600);
}

function faixa(msg) {
  const f = $("#faixa");
  f.textContent = msg || "";
  f.classList.toggle("escondida", !msg);
}

function vibrar(tipo) {
  try {
    const h = tg && tg.HapticFeedback;
    if (!h) return;
    if (tipo === "erro" || tipo === "sucesso" || tipo === "aviso") {
      h.notificationOccurred({ erro: "error", sucesso: "success", aviso: "warning" }[tipo]);
    } else {
      h.impactOccurred(tipo || "light");
    }
  } catch (e) { /* fora do Telegram */ }
}

function confirmar(msg, cb) {
  if (tg && tg.initData && tg.showConfirm) tg.showConfirm(msg, (ok) => ok && cb());
  else if (window.confirm(msg)) cb();
}

function enviar(obj) {
  if (S.demo) return S.demo.receber(obj);
  if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(obj));
  else toast("Sem conexão com o servidor…", "erro");
}

// ---------------------------------------------------------------- regras locais
function celulas(x, y, tam, h) {
  const r = [];
  for (let i = 0; i < tam; i++) r.push(h ? [x + i, y] : [x, y + i]);
  return r;
}

/** Devolve a mensagem de erro se a peça idx não puder ficar em pos, ou null. */
function conflito(pecas, idx, pos, encostar) {
  const cels = celulas(pos.x, pos.y, pecas[idx].tam, pos.h);
  for (const [cx, cy] of cels) {
    if (cx < 0 || cy < 0 || cx >= TAM || cy >= TAM) return "Não cabe aí.";
  }
  const ocup = new Set();
  pecas.forEach((p, i) => {
    if (i === idx || !p.pos) return;
    celulas(p.pos.x, p.pos.y, p.tam, p.pos.h).forEach(([a, b]) => ocup.add(a + "," + b));
  });
  for (const [cx, cy] of cels) {
    if (ocup.has(cx + "," + cy)) return "Já tem um navio aí.";
    if (!encostar) {
      for (let dx = -1; dx <= 1; dx++)
        for (let dy = -1; dy <= 1; dy++)
          if (ocup.has((cx + dx) + "," + (cy + dy))) return "Nesta frota os navios não podem encostar.";
    }
  }
  return null;
}

function sortear(pecas, encostar) {
  for (let t = 0; t < 500; t++) {
    pecas.forEach((p) => (p.pos = null));
    let ok = true;
    for (let i = 0; i < pecas.length && ok; i++) {
      ok = false;
      for (let k = 0; k < 300; k++) {
        const h = Math.random() < 0.5;
        const tam = pecas[i].tam;
        const pos = {
          h,
          x: Math.floor(Math.random() * (TAM - (h ? tam - 1 : 0))),
          y: Math.floor(Math.random() * (TAM - (h ? 0 : tam - 1))),
        };
        if (!conflito(pecas, i, pos, encostar)) { pecas[i].pos = pos; ok = true; break; }
      }
    }
    if (ok) return true;
  }
  return false;
}

// ---------------------------------------------------------------- desenho
function marcarNavio(cels, add) {
  if (!cels || !cels.length) return;
  const horiz = cels.length > 1 && cels[0][1] === cels[1][1];
  cels.forEach(([x, y], i) => {
    add(x, y, "navio");
    if (cels.length === 1) return add(x, y, "um");
    add(x, y, horiz ? "h" : "v");
    if (i === 0) add(x, y, "ini");
    if (i === cels.length - 1) add(x, y, "fim");
  });
}

function desenharTab(o) {
  const mapa = {};
  const add = (x, y, c) => (mapa[x + "," + y] = mapa[x + "," + y] || []).push(c);
  (o.navios || []).forEach((cels) => marcarNavio(cels, add));
  (o.afundados || []).forEach((a) => {
    if (!o.navios) marcarNavio(a.cels, add);
    a.cels.forEach(([x, y]) => add(x, y, "afundado"));
  });
  (o.tiros || []).forEach(([x, y, a]) => add(x, y, a ? "acerto" : "agua"));
  if (o.ultimo) add(o.ultimo.x, o.ultimo.y, "ultimo");
  (o.sel || []).forEach(([x, y]) => add(x, y, "sel"));

  const cls = ["tab", o.pequeno && "pequeno", o.clicavel && "clicavel", o.ativo && "ativo"].filter(Boolean).join(" ");
  let h = `<div class="${cls}"${o.acao ? ` data-acao="${o.acao}"` : ""}><div class="coord"></div>`;
  for (let x = 0; x < TAM; x++) h += `<div class="coord">${LETRAS[x]}</div>`;
  for (let y = 0; y < TAM; y++) {
    h += `<div class="coord">${y + 1}</div>`;
    for (let x = 0; x < TAM; x++) {
      const c = mapa[x + "," + y] || [];
      h += `<div class="cel ${c.join(" ")}" data-x="${x}" data-y="${y}"></div>`;
    }
  }
  return h + "</div>";
}

function blocos(tam) {
  return `<span class="blocos">${"<i></i>".repeat(tam)}</span>`;
}

function topo(e) {
  return `<div class="topo"><div><h1>Batalha Naval</h1><small>Acertou, joga de novo!</small></div>
    <div class="chip">⚓ ${esc(e.modo_nome)}</div></div>`;
}

function nomeJog(e, i) {
  const n = esc(e.jogadores[i] ? e.jogadores[i].nome : "—");
  return i === e.eu ? `${n} <span style="color:var(--suave);font-weight:500">(você)</span>` : n;
}

function placar(e) {
  const linha = (i) => {
    const j = e.jogadores[i];
    let s = "";
    if (e.fase === "posicionando") s = j.pronto ? "✅ Frota pronta" : "🛠️ Posicionando…";
    else if (e.fase === "batalha") s = `🚢 ${e.tabuleiros[i].restantes} navio(s)`;
    else if (e.fase === "fim") s = e.vencedor === i ? "🏆 Venceu" : `🚢 ${e.tabuleiros[i].restantes} navio(s)`;
    const vez = e.fase === "batalha" && e.vez === i ? " vez" : "";
    return `<div class="jog${vez}${i === 1 ? " dir" : ""}"><div class="n">${nomeJog(e, i)}</div><div class="s">${s}</div></div>`;
  };
  return `<div class="placar">${linha(0)}<div class="vs">VS</div>${linha(1)}</div>`;
}

function textoEvento(e) {
  const t = e.ultimo_tiro;
  if (!t) return "";
  const quem = t.por === e.eu ? "Você" : esc(e.jogadores[t.por].nome);
  const c = coord(t.x, t.y);
  if (t.resultado === "agua") return `🌊 ${quem} errou em ${c}`;
  if (t.resultado === "acerto") return `💥 ${quem} acertou em ${c}!`;
  return `🔥 ${quem} afundou o ${esc(t.navio)} em ${c}!`;
}

function rastreioFrota(e, dono) {
  const afund = new Set(e.tabuleiros[dono].afundados.map((a) => a.i));
  return `<div class="frota rastreio">${e.frota.map((n, i) =>
    `<div class="peca${afund.has(i) ? " afundada" : ""}">${blocos(n.tam)}${esc(n.nome)}</div>`).join("")}</div>`;
}

// ---------------------------------------------------------------- telas
function telaEspera(e) {
  let h = `<div class="card centro"><div class="radar"><span></span></div>
    <h2>Aguardando adversário</h2>`;
  if (e.papel === "pode_entrar") {
    h += `<p><b>${esc(e.jogadores[0].nome)}</b> está procurando alguém para a batalha.</p></div>
      <button class="b principal" data-b="entrar">⚔️ Entrar na partida</button><div class="dica"></div>`;
  } else {
    h += `<p>Quem tocar em <b>Abrir jogo</b> na mensagem da partida entra para jogar contra você.</p></div>`;
  }
  h += `<div class="rotulo"><span>Frota ${esc(e.modo_nome.toLowerCase())}</span><span>${e.frota.length} navios</span></div>
    ${rastreioFrota({ ...e, tabuleiros: [{ afundados: [] }] }, 0)}
    <div class="dica">${e.encostar ? "Os navios podem encostar uns nos outros." : "Os navios precisam de uma casa de água em volta (diagonal também)."}</div>`;
  if (e.eu === 0) h += `<button class="b perigo" data-b="desistir">Cancelar partida</button>`;
  return h;
}

function novoEditor(e) {
  return { pecas: e.frota.map((n) => ({ nome: n.nome, tam: n.tam, pos: null })), sel: 0, h: true, chave: e.id };
}

function telaPosicionar(e) {
  if (e.eu === null) {
    return `<div class="card centro"><div class="radar"><span></span></div><h2>Preparando a batalha</h2>
      <p>Os jogadores estão posicionando os navios…</p></div>`;
  }
  const op = 1 - e.eu;
  if (e.jogadores[e.eu].pronto) {
    return `<div class="status espera">⏳ Esperando ${esc(e.jogadores[op].nome)} posicionar a frota</div>
      <div class="rotulo"><span>Sua frota</span></div>
      ${desenharTab({ navios: e.tabuleiros[e.eu].navios })}
      <div id="relogio"></div>
      <button class="b perigo" data-b="desistir">Desistir</button>`;
  }

  if (!S.editor || S.editor.chave !== e.id) S.editor = novoEditor(e);
  const ed = S.editor;
  const navios = ed.pecas.filter((p) => p.pos).map((p) => celulas(p.pos.x, p.pos.y, p.tam, p.pos.h));
  const todos = ed.pecas.every((p) => p.pos);
  const pecas = ed.pecas.map((p, i) =>
    `<div class="peca${p.pos ? " ok" : ""}${i === ed.sel ? " sel" : ""}" data-b="peca" data-i="${i}">${blocos(p.tam)}${esc(p.nome)}</div>`).join("");

  return `<div class="status">🛠️ Posicione sua frota</div>
    <div class="dica">Escolha um navio e toque no mar. Toque num navio já colocado para tirá-lo.
      ${e.encostar ? "" : "<br><b>Os navios não podem encostar, nem na diagonal.</b>"}</div>
    <div class="frota">${pecas}</div>
    ${desenharTab({ navios, clicavel: true, ativo: true, acao: "posicionar" })}
    <div class="botoes">
      <button class="b" data-b="girar">${ed.h ? "↔️ Deitado" : "↕️ Em pé"}</button>
      <button class="b" data-b="aleatorio">🎲 Sortear</button>
      <button class="b" data-b="limpar">🧹 Limpar</button>
    </div>
    <button class="b principal verde" data-b="pronto"${todos ? "" : " disabled"}>✅ Frota pronta!</button>
    <div class="dica"></div>
    <button class="b perigo" data-b="desistir">Desistir</button>`;
}

function telaBatalha(e) {
  const evento = `<div class="evento">${textoEvento(e)}</div>`;
  const ut = e.ultimo_tiro;

  if (e.eu === null) {
    let h = `<div class="status espera">👀 Assistindo · vez de ${esc(e.jogadores[e.vez].nome)}</div>${evento}`;
    [0, 1].forEach((d) => {
      const tb = e.tabuleiros[d];
      h += `<div class="rotulo"><span>Mar de ${esc(e.jogadores[d].nome)}</span><span>${tb.restantes} navio(s)</span></div>
        ${desenharTab({ tiros: tb.tiros, afundados: tb.afundados, ultimo: ut && ut.por === 1 - d ? ut : null })}`;
    });
    return h;
  }

  const eu = e.eu, op = 1 - eu, minha = e.vez === eu;
  const alvo = e.tabuleiros[op], meu = e.tabuleiros[eu];
  return `<div class="status ${minha ? "minha" : "espera"}">${minha ? "🎯 Sua vez! Escolha onde atirar" : `⏳ Vez de ${esc(e.jogadores[op].nome)}`}</div>
    ${evento}
    <div class="rotulo"><span>Mar de ${esc(e.jogadores[op].nome)}</span><span>${alvo.restantes} navio(s)</span></div>
    ${desenharTab({ tiros: alvo.tiros, afundados: alvo.afundados, clicavel: minha, ativo: minha, acao: "atirar",
      ultimo: ut && ut.por === eu ? ut : null })}
    ${rastreioFrota(e, op)}
    <div class="rotulo"><span>Sua frota</span><span>${meu.restantes} navio(s)</span></div>
    ${desenharTab({ navios: meu.navios, tiros: meu.tiros, afundados: meu.afundados, pequeno: true,
      ultimo: ut && ut.por === op ? ut : null })}
    <div id="relogio"></div>
    <button class="b perigo" data-b="desistir">Desistir</button>`;
}

function telaFim(e) {
  let emoji = "🏆", titulo, cls = "";
  if (e.vencedor === null) {
    emoji = "💤"; titulo = "Partida encerrada";
  } else if (e.eu === e.vencedor) {
    titulo = "Vitória!"; cls = "vitoria";
  } else if (e.eu !== null) {
    emoji = "💥"; titulo = "Derrota"; cls = "derrota";
  } else {
    titulo = `${esc(e.jogadores[e.vencedor].nome)} venceu!`;
  }
  const perd = e.vencedor === null ? "" : esc(e.jogadores[1 - e.vencedor].nome);
  const motivo = {
    afundou: "Toda a frota adversária foi afundada.",
    desistiu: `${perd} desistiu.`,
    tempo: `${perd} ficou sem jogar.`,
    abandonada: "Ninguém jogou por 30 minutos.",
  }[e.motivo] || "";

  const ordem = e.eu === null ? [0, 1] : [e.eu, 1 - e.eu];
  let h = `<div class="card resultado ${cls}"><div class="emoji">${emoji}</div><h2>${titulo}</h2><p>${motivo}</p></div>`;
  ordem.forEach((d) => {
    const tb = e.tabuleiros[d];
    h += `<div class="rotulo"><span>Frota de ${nomeJog(e, d)}</span><span>${tb.restantes} navio(s) restante(s)</span></div>
      ${desenharTab({ navios: tb.navios, tiros: tb.tiros, afundados: tb.afundados })}`;
  });
  return h + `<button class="b fino" data-b="fechar">Fechar</button>`;
}

function telaErro(html) {
  $("#app").innerHTML = `<div class="carregando"><div style="font-size:48px">⚓</div>
    <div class="card centro" style="margin-top:12px"><p>${html}</p></div></div>`;
  faixa(null);
}

function render() {
  const e = S.estado;
  if (!e) return;
  let h = topo(e);
  if (e.fase === "aguardando") h += telaEspera(e);
  else if (e.fase === "cancelada") {
    h += `<div class="card centro"><div style="font-size:44px">❌</div><h2>Partida cancelada</h2>
      <p>Crie outra com /naval.</p></div><button class="b fino" data-b="fechar">Fechar</button>`;
  } else {
    h += placar(e);
    if (e.fase === "posicionando") h += telaPosicionar(e);
    else if (e.fase === "batalha") h += telaBatalha(e);
    else h += telaFim(e);
  }
  $("#app").innerHTML = h;
  atualizarRelogio();
}

// ---------------------------------------------------------------- relógio de inatividade
function atualizarRelogio() {
  const el = $("#relogio");
  const e = S.estado;
  if (!el || !e) return;
  if (!e.reivindicar_em || e.eu === null) { el.innerHTML = ""; return; }
  const agora = e.agora + (Date.now() - S.recebidoEm) / 1000;
  const resta = Math.ceil(e.reivindicar_em - agora);
  const op = esc(e.jogadores[1 - e.eu].nome);
  if (resta > 0) {
    const m = Math.floor(resta / 60), s = String(resta % 60).padStart(2, "0");
    const acao = e.fase === "batalha" ? "jogar" : "posicionar";
    el.innerHTML = `<div class="dica">⏱️ Se ${op} não ${acao} em ${m}:${s}, você pode reivindicar a vitória.</div>`;
  } else if (!el.querySelector("button")) {
    el.innerHTML = `<button class="b fino" data-b="reivindicar">🏳️ ${op} sumiu — reivindicar vitória</button><div class="dica"></div>`;
  }
}
setInterval(atualizarRelogio, 1000);

// ---------------------------------------------------------------- estado recebido
function receber(e) {
  const antes = S.estado;
  S.estado = e;
  S.recebidoEm = Date.now();
  S.enviando = false;

  if (antes) {
    const t = e.ultimo_tiro;
    if (t && JSON.stringify(t) !== JSON.stringify(antes.ultimo_tiro)) {
      if (t.por === e.eu) {
        if (t.resultado === "agua") vibrar("light");
        else if (t.resultado === "acerto") vibrar("heavy");
        else { vibrar("sucesso"); toast(`🔥 Você afundou o ${t.navio}!`); }
      } else if (e.eu !== null && t.resultado !== "agua") {
        vibrar("aviso");
      }
    }
    if (antes.fase !== e.fase) {
      if (e.fase === "posicionando") { vibrar("sucesso"); toast("⚔️ Adversário encontrado!"); }
      if (e.fase === "batalha") {
        vibrar("sucesso");
        toast(e.vez === e.eu ? "💥 A batalha começou! Você começa." : "💥 A batalha começou!");
      }
      if (e.fase === "fim" && e.eu !== null) vibrar(e.vencedor === e.eu ? "sucesso" : "erro");
    } else if (e.fase === "batalha" && antes.vez !== e.vez && e.vez === e.eu) {
      vibrar("medium");
    }
  }
  if (e.fase !== "posicionando") S.editor = null;
  render();
}

// ---------------------------------------------------------------- toques
function acaoCelula(acao, x, y) {
  const e = S.estado;
  if (!e) return;

  if (acao === "atirar") {
    if (e.fase !== "batalha" || e.vez !== e.eu || S.enviando) return;
    if (e.tabuleiros[1 - e.eu].tiros.some(([a, b]) => a === x && b === y)) {
      vibrar("erro");
      return toast("Você já atirou aí.");
    }
    S.enviando = true;
    vibrar("light");
    return enviar({ tipo: "atirar", x, y });
  }

  if (acao === "posicionar") {
    const ed = S.editor;
    if (!ed) return;
    // Tocou num navio já colocado: tira do mar e seleciona
    const achou = ed.pecas.findIndex((p) => p.pos &&
      celulas(p.pos.x, p.pos.y, p.tam, p.pos.h).some(([a, b]) => a === x && b === y));
    if (achou >= 0) {
      ed.h = ed.pecas[achou].pos.h;
      ed.pecas[achou].pos = null;
      ed.sel = achou;
      vibrar("light");
      return render();
    }
    if (ed.sel === null || ed.pecas[ed.sel].pos) return toast("Escolha um navio na lista acima.");
    const tam = ed.pecas[ed.sel].tam;
    // Se passar da borda, encaixa automaticamente dentro do tabuleiro
    const pos = { h: ed.h, x: ed.h ? Math.min(x, TAM - tam) : x, y: ed.h ? y : Math.min(y, TAM - tam) };
    const erro = conflito(ed.pecas, ed.sel, pos, S.estado.encostar);
    if (erro) { vibrar("erro"); return toast(erro, "erro"); }
    ed.pecas[ed.sel].pos = pos;
    vibrar("medium");
    const prox = ed.pecas.findIndex((p) => !p.pos);
    ed.sel = prox >= 0 ? prox : null;
    return render();
  }
}

function botao(nome, ds) {
  const e = S.estado;
  const ed = S.editor;
  switch (nome) {
    case "entrar":
      return enviar({ tipo: "entrar" });
    case "peca": {
      const i = +ds.i;
      if (ed.pecas[i].pos) { ed.h = ed.pecas[i].pos.h; ed.pecas[i].pos = null; }
      ed.sel = i;
      return render();
    }
    case "girar":
      ed.h = !ed.h;
      return render();
    case "aleatorio":
      sortear(ed.pecas, e.encostar);
      ed.sel = null;
      vibrar("medium");
      return render();
    case "limpar":
      ed.pecas.forEach((p) => (p.pos = null));
      ed.sel = 0;
      return render();
    case "pronto":
      if (!ed.pecas.every((p) => p.pos)) return;
      return enviar({ tipo: "posicionar", navios: ed.pecas.map((p) => ({ x: p.pos.x, y: p.pos.y, h: p.pos.h })) });
    case "desistir": {
      const msg = e.fase === "aguardando" ? "Cancelar esta partida?" : "Desistir da partida? A vitória vai para o adversário.";
      return confirmar(msg, () => enviar({ tipo: "desistir" }));
    }
    case "reivindicar":
      return enviar({ tipo: "reivindicar" });
    case "fechar":
      if (tg && tg.initData) tg.close();
      return;
  }
}

document.addEventListener("click", (ev) => {
  const cel = ev.target.closest(".cel");
  const tab = ev.target.closest(".tab");
  if (cel && tab && tab.dataset.acao) {
    return acaoCelula(tab.dataset.acao, +cel.dataset.x, +cel.dataset.y);
  }
  const b = ev.target.closest("[data-b]");
  if (b && !b.disabled) botao(b.dataset.b, b.dataset);
});

// ---------------------------------------------------------------- conexão
function lerParam() {
  const p = (tg && tg.initDataUnsafe && tg.initDataUnsafe.start_param)
    || new URLSearchParams(location.search).get("p") || "";
  const i = p.indexOf("_");
  return i < 0 ? { id: p, sub: null } : { id: p.slice(0, i), sub: p.slice(i + 1) };
}

function conectar() {
  const ws = new WebSocket(S.url);
  S.ws = ws;
  ws.onopen = () => {
    S.tentativas = 0;
    faixa(null);
    ws.send(JSON.stringify({ tipo: "auth", initData: tg.initData, partida: S.partida }));
  };
  ws.onmessage = (ev) => {
    let d;
    try { d = JSON.parse(ev.data); } catch (e) { return; }
    if (d.tipo === "estado") receber(d.estado);
    else if (d.tipo === "erro") { S.enviando = false; vibrar("erro"); toast(d.msg, "erro"); }
    else if (d.tipo === "fatal") { S.fatal = true; telaErro(esc(d.msg)); }
  };
  ws.onclose = () => {
    if (S.fatal) return;
    S.tentativas++;
    if (!S.estado && S.tentativas > 6) {
      return telaErro("Não consegui conectar ao servidor do jogo.<br>O bot pode estar desligado ou ter sido reiniciado. Crie uma nova partida com /naval.");
    }
    faixa("Conexão perdida… reconectando");
    setTimeout(conectar, Math.min(1000 * S.tentativas, 8000));
  };
}

function iniciar() {
  if (tg) {
    tg.ready();
    tg.expand();
    try { tg.setHeaderColor("#0d1733"); tg.setBackgroundColor("#070d1f"); } catch (e) { /* versões antigas */ }
  }
  const q = new URLSearchParams(location.search);
  if (q.has("demo")) return Demo.iniciar(q.get("demo"));

  const { id, sub } = lerParam();
  if (!tg || !tg.initData) return telaErro("Abra este jogo pelo botão <b>Abrir jogo</b> da partida no Telegram.");
  if (!id) return telaErro("Nenhuma partida informada. Abra pelo botão <b>Abrir jogo</b> da partida.");
  S.url = sub ? `wss://${sub}.trycloudflare.com/ws` : (window.CONFIG && CONFIG.SERVIDOR_PADRAO);
  if (!S.url) return telaErro("Endereço do servidor não configurado.");
  S.partida = id;
  conectar();
}

// ---------------------------------------------------------------- modo demonstração (?demo)
// Joga contra um robô sem precisar do bot ligado. Útil para testar o visual.
const Demo = {
  iniciar(modo) {
    const frotas = {
      classica: [["Porta-aviões", 5], ["Encouraçado", 4], ["Cruzador", 3], ["Submarino", 3], ["Destróier", 2]],
      brasileira: [["Porta-aviões", 5], ["Encouraçado", 4], ["Cruzador", 3], ["Cruzador", 3], ["Destróier", 2],
        ["Destróier", 2], ["Submarino", 1], ["Submarino", 1], ["Submarino", 1], ["Submarino", 1]],
    };
    this.modo = frotas[modo] ? modo : "classica";
    this.encostar = this.modo === "classica";
    this.frota = frotas[this.modo].map(([nome, tam]) => ({ nome, tam }));
    this.j = [{ nome: "Comandante", pronto: false, navios: [], tiros: new Map() },
              { nome: "Robô", pronto: false, navios: [], tiros: new Map() }];
    this.fase = "aguardando"; this.vez = 0; this.vencedor = null; this.motivo = null; this.ultimo = null;
    S.demo = this;
    faixa("Modo demonstração · jogando contra o robô");
    this.publicar();
    setTimeout(() => { this.fase = "posicionando"; this.publicar(); this.roboPosiciona(); }, 1800);
  },
  roboPosiciona() {
    setTimeout(() => {
      const pecas = this.frota.map((n) => ({ ...n, pos: null }));
      sortear(pecas, this.encostar);
      this.j[1].navios = pecas.map((p) => celulas(p.pos.x, p.pos.y, p.tam, p.pos.h));
      this.j[1].pronto = true;
      this.comecarSePronto();
      this.publicar();
    }, 2500);
  },
  comecarSePronto() {
    if (this.j.every((j) => j.pronto) && this.fase === "posicionando") {
      this.fase = "batalha";
      this.vez = Math.random() < 0.5 ? 0 : 1;
      if (this.vez === 1) this.roboAtira();
    }
  },
  afundados(d) {
    const tiros = this.j[1 - d].tiros;
    return this.j[d].navios.map((c, i) => ({ i, cels: c }))
      .filter((n) => n.cels.every(([x, y]) => tiros.get(x + "," + y) === 1));
  },
  atirar(i, x, y) {
    const eu = this.j[i], alvo = this.j[1 - i];
    const k = x + "," + y;
    if (eu.tiros.has(k)) return toast("Você já atirou aí.", "erro");
    const n = alvo.navios.findIndex((c) => c.some(([a, b]) => a === x && b === y));
    eu.tiros.set(k, n >= 0 ? 1 : 0);
    let res = n >= 0 ? "acerto" : "agua";
    if (n >= 0 && alvo.navios[n].every(([a, b]) => eu.tiros.get(a + "," + b) === 1)) {
      res = "afundou";
      if (!this.encostar) alvo.navios[n].forEach(([a, b]) => {
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
          const v = (a + dx) + "," + (b + dy);
          if (a + dx >= 0 && b + dy >= 0 && a + dx < TAM && b + dy < TAM && !eu.tiros.has(v)) eu.tiros.set(v, 0);
        }
      });
    }
    this.ultimo = { por: i, x, y, resultado: res, navio: n >= 0 ? this.frota[n].nome : null };
    if (res === "afundou" && this.afundados(1 - i).length === alvo.navios.length) {
      this.fase = "fim"; this.vencedor = i; this.motivo = "afundou";
    } else if (res === "agua") {
      this.vez = 1 - i;
    }
    this.publicar();
    if (this.fase === "batalha" && this.vez === 1) this.roboAtira();
  },
  roboAtira() {
    setTimeout(() => {
      const t = this.j[1].tiros;
      // Caça: tenta os vizinhos de acertos que ainda não afundaram
      const afund = new Set(this.afundados(0).flatMap((n) => n.cels.map(([a, b]) => a + "," + b)));
      const candidatos = [];
      t.forEach((v, k) => {
        if (v !== 1 || afund.has(k)) return;
        const [a, b] = k.split(",").map(Number);
        [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(([dx, dy]) => {
          const x = a + dx, y = b + dy;
          if (x >= 0 && y >= 0 && x < TAM && y < TAM && !t.has(x + "," + y)) candidatos.push([x, y]);
        });
      });
      if (!candidatos.length) {
        for (let x = 0; x < TAM; x++) for (let y = 0; y < TAM; y++) if (!t.has(x + "," + y)) candidatos.push([x, y]);
      }
      const [x, y] = candidatos[Math.floor(Math.random() * candidatos.length)];
      this.atirar(1, x, y);
    }, 900);
  },
  receber(m) {
    if (m.tipo === "posicionar") {
      this.j[0].navios = m.navios.map((p, i) => celulas(p.x, p.y, this.frota[i].tam, p.h));
      this.j[0].pronto = true;
      this.comecarSePronto();
      this.publicar();
    } else if (m.tipo === "atirar") {
      this.atirar(0, m.x, m.y);
    } else if (m.tipo === "desistir") {
      if (this.fase === "aguardando") this.fase = "cancelada";
      else { this.fase = "fim"; this.vencedor = 1; this.motivo = "desistiu"; }
      this.publicar();
    }
  },
  publicar() {
    const fim = this.fase === "fim";
    const tab = (d) => {
      const af = this.afundados(d);
      const r = {
        tiros: [...this.j[1 - d].tiros].map(([k, v]) => [...k.split(",").map(Number), v]),
        afundados: af, restantes: this.frota.length - af.length,
      };
      if (d === 0 || fim) r.navios = this.j[d].navios;
      return r;
    };
    receber({
      id: "demo", versao: Date.now(), agora: Date.now() / 1000, modo: this.modo,
      modo_nome: this.modo === "classica" ? "Clássica" : "Brasileira", encostar: this.encostar,
      frota: this.frota, fase: this.fase, papel: "jogador", eu: 0,
      jogadores: this.fase === "aguardando" ? [{ nome: "Comandante", pronto: false }] : this.j.map((j) => ({ nome: j.nome, pronto: j.pronto })),
      vez: this.vez, vencedor: this.vencedor, motivo: this.motivo, ultimo_tiro: this.ultimo,
      tabuleiros: this.fase === "aguardando" ? [] : [tab(0), tab(1)], reivindicar_em: null,
    });
  },
};

iniciar();
