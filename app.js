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

// ---------------------------------------------------------------- sons (gerados, sem arquivos)
const Som = {
  ligado: true, ctx: null,
  iniciar() {
    try { this.ligado = localStorage.getItem("som") !== "0"; } catch (e) { /* sem armazenamento */ }
    this.botao();
  },
  botao() {
    let b = $("#som");
    if (!b) {
      b = document.createElement("button");
      b.id = "som";
      b.className = "som";
      b.addEventListener("click", (ev) => { ev.stopPropagation(); this.alternar(); });
      document.body.appendChild(b);
    }
    b.textContent = this.ligado ? "🔊" : "🔇";
    b.title = this.ligado ? "Desligar sons" : "Ligar sons";
  },
  alternar() {
    this.ligado = !this.ligado;
    try { localStorage.setItem("som", this.ligado ? "1" : "0"); } catch (e) { /* ok */ }
    this.botao();
    if (this.ligado) this.tocar("medium");
  },
  destravar() {
    // O navegador só libera áudio depois de um toque na tela
    try {
      if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      if (this.ctx.state === "suspended") this.ctx.resume();
    } catch (e) { this.ctx = null; }
  },
  nota(freq, ini, dur, tipo = "sine", vol = 0.12) {
    const c = this.ctx, t = c.currentTime + ini;
    const o = c.createOscillator(), g = c.createGain();
    o.type = tipo;
    o.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(c.destination);
    o.start(t);
    o.stop(t + dur + 0.02);
  },
  tocar(tipo) {
    if (!this.ligado || !this.ctx || this.ctx.state !== "running") return;
    try {
      const sons = {
        light: () => this.nota(880, 0, 0.05, "triangle", 0.06),
        medium: () => this.nota(660, 0, 0.08, "triangle", 0.09),
        heavy: () => { this.nota(180, 0, 0.18, "square", 0.08); this.nota(120, 0.03, 0.2, "sine", 0.1); },
        sucesso: () => { this.nota(660, 0, 0.12); this.nota(880, 0.1, 0.12); this.nota(1175, 0.2, 0.22); },
        erro: () => { this.nota(220, 0, 0.14, "sawtooth", 0.06); this.nota(165, 0.12, 0.2, "sawtooth", 0.06); },
        aviso: () => { this.nota(392, 0, 0.12, "triangle"); this.nota(330, 0.12, 0.16, "triangle"); },
      };
      (sons[tipo] || sons.light)();
    } catch (e) { /* sem som */ }
  },
};

function vibrar(tipo) {
  Som.tocar(tipo || "light");
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
  if (o.prev) o.prev.cels.forEach(([x, y]) => {
    if (x >= 0 && y >= 0 && x < TAM && y < TAM) { add(x, y, "prev"); if (o.prev.ruim) add(x, y, "ruim"); }
  });

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
  return { pecas: e.frota.map((n) => ({ nome: n.nome, tam: n.tam, pos: null })), sel: 0, h: true, chave: e.id, prev: null };
}

/** Posição que o navio selecionado teria com a âncora em (x, y), já encaixada na borda. */
function posPrevia(ed, x, y) {
  const tam = ed.pecas[ed.sel].tam;
  return { h: ed.h, x: ed.h ? Math.min(x, TAM - tam) : x, y: ed.h ? y : Math.min(y, TAM - tam) };
}

function previa(ed) {
  if (ed.sel === null || !ed.prev || ed.pecas[ed.sel].pos) return null;
  const pos = posPrevia(ed, ed.prev.x, ed.prev.y);
  return {
    pos,
    cels: celulas(pos.x, pos.y, ed.pecas[ed.sel].tam, pos.h),
    erro: conflito(ed.pecas, ed.sel, pos, S.estado.encostar),
  };
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
  const pv = previa(ed);
  let instrucao = "Escolha um navio e toque no mar. Toque num navio já colocado para tirá-lo.";
  if (pv && pv.erro) instrucao = `<span style="color:#fb7185">❌ ${esc(pv.erro)} Toque em outro lugar ou gire.</span>`;
  else if (pv) instrucao = `<span style="color:#34d399">👆 Toque de novo no navio verde para confirmar.</span>`;
  const pecas = ed.pecas.map((p, i) =>
    `<div class="peca${p.pos ? " ok" : ""}${i === ed.sel ? " sel" : ""}" data-b="peca" data-i="${i}">${blocos(p.tam)}${esc(p.nome)}</div>`).join("");

  return `<div class="status">🛠️ Posicione sua frota</div>
    <div class="dica">${instrucao}
      ${e.encostar ? "" : "<br><b>Os navios não podem encostar, nem na diagonal.</b>"}</div>
    <div class="frota">${pecas}</div>
    ${desenharTab({ navios, clicavel: true, ativo: true, acao: "posicionar",
      prev: pv ? { cels: pv.cels, ruim: !!pv.erro } : null })}
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
  h += blocoRevanche(e);
  ordem.forEach((d) => {
    const tb = e.tabuleiros[d];
    h += `<div class="rotulo"><span>Frota de ${nomeJog(e, d)}</span><span>${tb.restantes} restante(s)</span></div>
      ${desenharTab({ navios: tb.navios, tiros: tb.tiros, afundados: tb.afundados })}`;
  });
  return h + `<button class="b fino" data-b="fechar">Fechar</button>`;
}

function telaBoasVindas() {
  S.demo = null;
  S.estado = null;
  faixa(null);
  mostrarAssistindo(null);
  $("#app").innerHTML = `
    <div class="topo"><div><h1>Jogos</h1><small>Desafie alguém do grupo!</small></div><div class="chip">🎮</div></div>
    <div class="card vip">
      <h2>👑 Criar partidas é para usuários VIP</h2>
      <p>Quem é VIP cria a partida no grupo com <b>/naval</b>, <b>/damas</b>, <b>/memoria</b> ou <b>/pontinhos</b>. Não é VIP? Sem problema:
        toque em <b>🎮 Abrir jogo</b> na mensagem da partida e entre para jogar!</p>
    </div>
    <div class="card">
      <h2>⚓ Batalha Naval</h2>
      <p>1. Posicione sua frota no mar (dá para sortear).<br>
         2. Na sua vez, toque no mar adversário para atirar.<br>
         3. <b>Acertou? Joga de novo.</b> Errou? Passa a vez.<br>
         4. Quem afundar todos os navios do outro primeiro vence.</p>
      <p><b>Frota clássica:</b> 5 navios (5, 4, 3, 3 e 2 casas), podem encostar.<br>
         <b>Frota brasileira:</b> 10 navios (5, 4, 3, 3, 2, 2, 1, 1, 1 e 1), com uma casa de água em volta.</p>
      <div class="botoes dois">
        <button class="b" data-b="treino" data-modo="classica">🤖 Treinar clássica</button>
        <button class="b" data-b="treino" data-modo="brasileira">🤖 Treinar brasileira</button>
      </div>
    </div>
    <div class="card">
      <h2>♟️ Damas · regra brasileira</h2>
      <p>• As brancas começam. A pedra anda 1 casa na diagonal para frente.<br>
         • <b>Comer é obrigatório</b>, e vale o lance que come <b>mais peças</b>.<br>
         • A pedra come para frente e para trás.<br>
         • Chegou ao outro lado? Vira <b>dama ♛</b>, que anda e come à distância.<br>
         • Empate por acordo ou com 20 lances seguidos só de damas, sem captura.</p>
      <button class="b fino" data-b="treino_damas">🤖 Treinar damas</button>
    </div>
    <div class="card">
      <h2>🧠 Jogo da Memória</h2>
      <p>• Na sua vez, vire 2 cartas.<br>
         • <b>Formou par? É seu e você joga de novo.</b><br>
         • Errou? As cartas viram de volta e a vez passa.<br>
         • Quem fizer mais pares vence.</p>
      <div class="botoes">
        <button class="b" data-b="treino_memoria" data-modo="facil">🟢 Fácil</button>
        <button class="b" data-b="treino_memoria" data-modo="medio">🟡 Médio</button>
        <button class="b" data-b="treino_memoria" data-modo="dificil">🔴 Difícil</button>
      </div>
    </div>
    <div class="card">
      <h2>🔲 Pontinhos</h2>
      <p>• Na sua vez, ligue dois pontos vizinhos (de lado ou de cima a baixo).<br>
         • <b>Fechou um quadradinho? É seu e você joga de novo.</b><br>
         • Cuidado para não deixar o 3º lado de um quadradinho para o adversário!<br>
         • Quem fechar mais quadradinhos vence.</p>
      <div class="botoes">
        <button class="b" data-b="treino_pontinhos" data-modo="pequeno">🟢 4x4</button>
        <button class="b" data-b="treino_pontinhos" data-modo="medio">🟡 6x6</button>
        <button class="b" data-b="treino_pontinhos" data-modo="grande">🔴 8x8</button>
      </div>
    </div>
    <div class="dica">⏱️ Ficou muito tempo sem jogar? O adversário pode reivindicar a vitória.<br>
      O treino contra o robô não vale para o ranking.</div>`;
}

function blocoRevanche(e) {
  if (e.eu === null || e.jogadores.length !== 2 || e.proxima) return "";
  const op = esc(e.jogadores[1 - e.eu].nome);
  const eu = e.revanche.includes(e.eu), ele = e.revanche.includes(1 - e.eu);
  if (ele && !eu) {
    return `<div class="card centro destaque"><h2>🔁 ${op} quer revanche!</h2>
      <button class="b principal verde" data-b="revanche">✅ Aceitar revanche</button></div>`;
  }
  if (eu) return `<div class="card centro"><p>⏳ Esperando ${op} aceitar a revanche…</p></div>`;
  return `<button class="b principal" data-b="revanche">🔁 Pedir revanche</button><div class="dica"></div>`;
}

function telaErro(html) {
  $("#app").innerHTML = `<div class="carregando"><div style="font-size:48px">⚓</div>
    <div class="card centro" style="margin-top:12px"><p>${html}</p></div></div>`;
  faixa(null);
}

function render() {
  const e = S.estado;
  if (!e) return;
  if (e.jogo === "damas") {
    $("#app").innerHTML = telaDamas(e);
    return atualizarRelogio();
  }
  if (e.jogo === "pontinhos") {
    $("#app").innerHTML = telaPontinhos(e);
    return atualizarRelogio();
  }
  if (e.jogo === "memoria") {
    $("#app").innerHTML = telaMemoria(e);
    MS.vistas = new Set(e.cartas.map((c, i) => (c.s ? i : -1)).filter((i) => i >= 0));
    return atualizarRelogio();
  }
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
    const acao = e.fase === "posicionando" ? "posicionar" : "jogar";
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

  if (e.jogo === "damas") {
    if (!antes || antes.versao !== e.versao || antes.id !== e.id) { DS.sel = null; DS.parcial = []; }
    if (antes && antes.id === e.id) feedbackDamas(antes, e);
  } else if (e.jogo === "memoria") {
    if (!antes || antes.id !== e.id) MS.vistas = new Set();
    else feedbackMemoria(antes, e);
  } else if (e.jogo === "pontinhos") {
    if (antes && antes.id === e.id) feedbackPontinhos(antes, e);
  } else if (antes) {
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
  mostrarAssistindo(e);

  // Revanche criada: todo mundo que está vendo esta partida vai para a nova
  if (e.proxima && (!antes || !antes.proxima)) {
    vibrar("sucesso");
    toast("🔁 Revanche começando!");
    setTimeout(() => irPara(e.proxima), 900);
  }
}

function mostrarAssistindo(e) {
  let el = $("#assistindo");
  if (!el) {
    el = document.createElement("div");
    el.id = "assistindo";
    el.className = "assistindo escondida";
    document.body.appendChild(el);
  }
  const n = (e && e.assistindo) || 0;
  el.textContent = `👀 ${n} assistindo`;
  el.classList.toggle("escondida", !n);
}

function irPara(id) {
  if (S.demo) return S.demo.iniciar(S.demo.modo, true);
  S.partida = id;
  S.estado = null;
  S.editor = null;
  if (S.ws && S.ws.readyState === 1) {
    S.ws.send(JSON.stringify({ tipo: "auth", initData: tg.initData, partida: id }));
  }
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
      const antiga = ed.pecas[achou].pos;
      ed.h = antiga.h;
      ed.pecas[achou].pos = null;
      ed.sel = achou;
      ed.prev = { x: antiga.x, y: antiga.y };  // prévia onde ele estava
      vibrar("light");
      return render();
    }
    if (ed.sel === null || ed.pecas[ed.sel].pos) return toast("Escolha um navio na lista acima.");

    // 1º toque mostra a prévia; tocar de novo dentro dela confirma
    const pv = previa(ed);
    const dentro = pv && pv.cels.some(([a, b]) => a === x && b === y);
    if (!dentro) {
      ed.prev = { x, y };
      vibrar("light");
      return render();
    }
    if (pv.erro) { vibrar("erro"); return toast(pv.erro, "erro"); }
    ed.pecas[ed.sel].pos = pv.pos;
    ed.prev = null;
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
      if (ed.pecas[i].pos) {
        const antiga = ed.pecas[i].pos;
        ed.h = antiga.h; ed.pecas[i].pos = null; ed.prev = { x: antiga.x, y: antiga.y };
      }
      ed.sel = i;
      return render();
    }
    case "girar":
      ed.h = !ed.h;
      return render();
    case "aleatorio":
      sortear(ed.pecas, e.encostar);
      ed.sel = null;
      ed.prev = null;
      vibrar("medium");
      return render();
    case "limpar":
      ed.pecas.forEach((p) => (p.pos = null));
      ed.sel = 0;
      ed.prev = null;
      return render();
    case "pronto":
      if (!ed.pecas.every((p) => p.pos)) return;
      return enviar({ tipo: "posicionar", navios: ed.pecas.map((p) => ({ x: p.pos.x, y: p.pos.y, h: p.pos.h })) });
    case "desistir": {
      const msg = e.fase === "aguardando" ? "Cancelar esta partida?" : "Desistir da partida? A vitória vai para o adversário.";
      if (S.demo) return S.demo.receber({ tipo: "desistir" });
      return confirmar(msg, () => enviar({ tipo: "desistir" }));
    }
    case "reivindicar":
      return enviar({ tipo: "reivindicar" });
    case "revanche":
      vibrar("light");
      return enviar({ tipo: "revanche" });
    case "treino":
      return Demo.iniciar(ds.modo);
    case "treino_damas":
      return DemoDamas.iniciar();
    case "treino_memoria":
      return DemoMemoria.iniciar(ds.modo);
    case "treino_pontinhos":
      return DemoPontinhos.iniciar(ds.modo);
    case "empate":
      return confirmar("Propor empate ao adversário?", () => enviar({ tipo: "empate" }));
    case "aceitar_empate":
      return enviar({ tipo: "empate" });
    case "recusar_empate":
      return enviar({ tipo: "recusar_empate" });
    case "fechar":
      if (S.demo) return telaBoasVindas();
      if (tg && tg.initData) tg.close();
      return;
  }
}

document.addEventListener("pointerdown", () => Som.destravar(), { passive: true });

document.addEventListener("click", (ev) => {
  const linhaP = ev.target.closest("[data-lt]");
  if (linhaP && linhaP.closest(".ptab")) return tocarPontinhos(linhaP.dataset.lt, +linhaP.dataset.r, +linhaP.dataset.c);
  const carta = ev.target.closest(".carta");
  if (carta && carta.closest(".mtab")) return tocarMemoria(+carta.dataset.i);
  const casa = ev.target.closest(".dcasa");
  if (casa && casa.closest(".dtab")) return tocarDamas(+casa.dataset.x, +casa.dataset.y);
  const cel = ev.target.closest(".cel");
  const tab = ev.target.closest(".tab");
  if (cel && tab && tab.dataset.acao) {
    return acaoCelula(tab.dataset.acao, +cel.dataset.x, +cel.dataset.y);
  }
  const b = ev.target.closest("[data-b]");
  if (b && !b.disabled) botao(b.dataset.b, b.dataset);
});

// ================================================================ DAMAS
const DS = { sel: null, parcial: [] };   // peça escolhida e casas já tocadas
const ICONE_COR = ["⚪", "⚫"];
const NOME_COR = ["brancas", "pretas"];

const corDe = (e, i) => (e.jogadores[i] ? e.jogadores[i].cor : null);
const mesmaCasa = (a, b) => a && b && a[0] === b[0] && a[1] === b[1];
const prefixo = (caminho, parcial) => parcial.every((c, i) => mesmaCasa(caminho[i], c));

function placarDamas(e) {
  const linha = (i) => {
    const j = e.jogadores[i];
    if (!j) return `<div class="jog"></div>`;
    const [pd, dm] = e.pecas[j.cor];
    let s = `${ICONE_COR[j.cor]} ${pd} pedra(s)${dm ? ` · ♛ ${dm}` : ""}`;
    if (e.fase === "fim" && e.vencedor === i) s = "🏆 Venceu";
    const vez = e.fase === "jogando" && e.vez === i ? " vez" : "";
    return `<div class="jog${vez}${i === 1 ? " dir" : ""}"><div class="n">${nomeJog(e, i)}</div><div class="s">${s}</div></div>`;
  };
  return `<div class="placar">${linha(0)}<div class="vs">VS</div>${linha(1)}</div>`;
}

function desenharDamas(e, interativo) {
  const minhaCor = e.eu !== null ? corDe(e, e.eu) : Damas.BRANCAS;
  const virar = minhaCor === Damas.PRETAS;  // sua cor sempre embaixo
  const t = e.tabuleiro;
  const movs = interativo ? (e.movimentos || []) : [];
  const podeMover = new Set(movs.map((m) => m.de.join(",")));
  const selKey = DS.sel ? DS.sel.join(",") : null;

  const alvos = new Set();
  if (DS.sel) {
    movs.filter((m) => mesmaCasa(m.de, DS.sel) && prefixo(m.caminho, DS.parcial))
      .forEach((m) => { const prox = m.caminho[DS.parcial.length]; if (prox) alvos.add(prox.join(",")); });
  }
  const rastro = new Set(), comidas = new Set();
  if (e.ultimo && !DS.sel) {
    rastro.add(e.ultimo.de.join(","));
    e.ultimo.caminho.forEach((c) => rastro.add(c.join(",")));
    e.ultimo.capturas.forEach((c) => comidas.add(c.join(",")));
  }
  const passos = new Set(DS.parcial.map((c) => c.join(",")));
  const fimParcial = DS.parcial.length ? DS.parcial[DS.parcial.length - 1] : null;

  let h = `<div class="dtab${interativo ? " ativo" : ""}">`;
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const x = virar ? 7 - c : c, y = virar ? 7 - r : r, k = x + "," + y;
      const cls = ["dcasa", (x + y) % 2 ? "escura" : "clara"];
      if (rastro.has(k)) cls.push("rastro");
      if (passos.has(k)) cls.push("passo");
      if (alvos.has(k)) cls.push("alvo");

      // Durante uma captura em andamento, a peça aparece no último passo
      let ch = t[y][x];
      if (DS.sel && fimParcial) {
        if (k === selKey) ch = ".";
        if (mesmaCasa(fimParcial, [x, y])) ch = t[DS.sel[1]][DS.sel[0]];
      }

      let dentro = "";
      if (c === 0) dentro += `<span class="rl">${8 - y}</span>`;
      if (r === 7) dentro += `<span class="rc">${"abcdefgh"[x]}</span>`;
      if (ch !== ".") {
        const pc = ["pd", Damas.dono(ch) === Damas.BRANCAS ? "branca" : "preta"];
        if (Damas.ehDama(ch)) pc.push("dama");
        if (!DS.sel && podeMover.has(k)) pc.push("pode");
        if (k === selKey || (fimParcial && mesmaCasa(fimParcial, [x, y]))) pc.push("selec");
        dentro += `<div class="${pc.join(" ")}">${Damas.ehDama(ch) ? "♛" : ""}</div>`;
      } else if (comidas.has(k)) {
        dentro += `<div class="comida">✕</div>`;
      }
      h += `<div class="${cls.join(" ")}" data-x="${x}" data-y="${y}">${dentro}</div>`;
    }
  }
  return h + "</div>";
}

function textoEventoDamas(e) {
  const u = e.ultimo;
  if (!u) return e.fase === "jogando" ? "As brancas começam." : "";
  const quem = u.por === e.eu ? "Você" : esc(e.jogadores[u.por].nome);
  const rota = [u.de].concat(u.caminho).map(([x, y]) => Damas.notacao(x, y)).join(u.capturas.length ? " ✕ " : " → ");
  let t = u.capturas.length ? `💥 ${quem} comeu ${u.capturas.length} peça(s): ${rota}` : `♟️ ${quem}: ${rota}`;
  if (u.virou_dama) t += " · virou dama ♛";
  return t;
}

function telaDamas(e) {
  let h = `<div class="topo"><div><h1>Damas</h1><small>Regra brasileira</small></div><div class="chip">♟️ Damas</div></div>`;

  if (e.fase === "aguardando") {
    h += `<div class="card centro"><div class="radar"><span></span></div><h2>Aguardando adversário</h2>`;
    if (e.papel === "pode_entrar") {
      h += `<p><b>${esc(e.jogadores[0].nome)}</b> está procurando alguém para jogar.</p></div>
        <button class="b principal" data-b="entrar">♟️ Entrar na partida</button><div class="dica">As cores são sorteadas. As brancas começam.</div>`;
    } else {
      h += `<p>Quem tocar em <b>Abrir jogo</b> na mensagem da partida entra para jogar contra você.</p></div>
        <div class="dica">As cores são sorteadas quando o adversário entrar.</div>`;
    }
    if (e.eu === 0) h += `<button class="b perigo" data-b="desistir">Cancelar partida</button>`;
    return h;
  }
  if (e.fase === "cancelada") {
    return h + `<div class="card centro"><div style="font-size:44px">❌</div><h2>Partida cancelada</h2>
      <p>Crie outra com /damas.</p></div><button class="b fino" data-b="fechar">Fechar</button>`;
  }

  h += placarDamas(e);

  if (e.fase === "jogando") {
    const jogador = e.eu !== null;
    const minha = jogador && e.vez === e.eu;
    const captura = minha && e.movimentos.length && e.movimentos[0].capturas.length;
    if (!jogador) {
      h += `<div class="status espera">👀 Assistindo · vez das ${NOME_COR[corDe(e, e.vez)]}</div>`;
    } else if (minha) {
      h += `<div class="status minha">🎯 Sua vez! ${ICONE_COR[corDe(e, e.eu)]}${captura ? ` · Captura obrigatória (${captura})` : ""}</div>`;
    } else {
      h += `<div class="status espera">⏳ Vez de ${esc(e.jogadores[e.vez].nome)}</div>`;
    }
    h += `<div class="evento">${textoEventoDamas(e)}</div>`;

    if (jogador && e.empate_proposto === 1 - e.eu) {
      h += `<div class="card centro destaque"><h2>🤝 ${esc(e.jogadores[1 - e.eu].nome)} propôs empate</h2>
        <div class="botoes dois"><button class="b verde" data-b="aceitar_empate">✅ Aceitar</button>
        <button class="b" data-b="recusar_empate">❌ Recusar</button></div></div>`;
    }

    h += desenharDamas(e, minha && !S.enviando);
    if (minha && DS.sel && DS.parcial.length) h += `<div class="dica">Continue: toque na próxima casa marcada. Toque na peça de origem para recomeçar.</div>`;
    else if (minha && !DS.sel) h += `<div class="dica">Toque numa peça destacada e depois na casa de destino.</div>`;
    if (e.lances_damas > 0) h += `<div class="dica">♛ ${e.lances_damas}/${e.limite_lances_damas} lances seguidos só de damas (empate em ${e.limite_lances_damas})</div>`;
    h += `<div id="relogio"></div>`;
    if (jogador) {
      const propus = e.empate_proposto === e.eu;
      h += `<div class="botoes dois">
        <button class="b" data-b="empate"${propus ? " disabled" : ""}>${propus ? "🤝 Empate proposto" : "🤝 Propor empate"}</button>
        <button class="b perigo" data-b="desistir" style="width:auto">🏳️ Desistir</button></div>`;
    }
    return h;
  }

  // FIM
  let emoji = "🏆", titulo, cls = "";
  if (e.vencedor === null) {
    const empate = (e.motivo || "").startsWith("empate");
    emoji = empate ? "🤝" : "💤"; titulo = empate ? "Empate" : "Partida encerrada";
  } else if (e.eu === e.vencedor) {
    titulo = "Vitória!"; cls = "vitoria";
  } else if (e.eu !== null) {
    emoji = "💥"; titulo = "Derrota"; cls = "derrota";
  } else {
    titulo = `${esc(e.jogadores[e.vencedor].nome)} venceu!`;
  }
  const perd = e.vencedor === null ? "" : esc(e.jogadores[1 - e.vencedor].nome);
  const motivo = {
    sem_pecas: "Todas as peças adversárias foram comidas.",
    bloqueado: `${perd} ficou sem lances possíveis.`,
    desistiu: `${perd} desistiu.`,
    tempo: `${perd} ficou sem jogar.`,
    empate_acordo: "Empate combinado entre os dois.",
    empate_20: "20 lances seguidos só de damas, sem captura.",
    abandonada: "Ninguém jogou por 30 minutos.",
  }[e.motivo] || "";
  h += `<div class="card resultado ${cls}"><div class="emoji">${emoji}</div><h2>${titulo}</h2><p>${motivo}</p></div>`;
  h += blocoRevanche(e);
  h += desenharDamas(e, false);
  return h + `<button class="b fino" data-b="fechar">Fechar</button>`;
}

function tocarDamas(x, y) {
  const e = S.estado;
  if (!e || e.jogo !== "damas" || e.fase !== "jogando" || e.eu === null || e.vez !== e.eu || S.enviando) return;
  const movs = e.movimentos || [];

  if (DS.sel) {
    // Tocou na peça de origem: recomeça (ou desmarca)
    if (mesmaCasa(DS.sel, [x, y])) {
      if (DS.parcial.length) DS.parcial = []; else DS.sel = null;
      vibrar("light");
      return render();
    }
    const cands = movs.filter((m) => mesmaCasa(m.de, DS.sel) && prefixo(m.caminho, DS.parcial));
    const prox = cands.filter((m) => mesmaCasa(m.caminho[DS.parcial.length], [x, y]));
    if (prox.length) {
      DS.parcial = DS.parcial.concat([[x, y]]);
      const completo = prox.find((m) => m.caminho.length === DS.parcial.length);
      if (completo) {
        S.enviando = true;
        vibrar(completo.capturas.length ? "heavy" : "medium");
        enviar({ tipo: "mover", de: completo.de, caminho: completo.caminho });
      } else {
        vibrar("light");
      }
      return render();
    }
    if (DS.parcial.length) {
      vibrar("erro");
      return toast("Continue comendo: toque numa casa marcada.");
    }
  }

  if (movs.some((m) => mesmaCasa(m.de, [x, y]))) {
    DS.sel = [x, y];
    DS.parcial = [];
    vibrar("light");
    return render();
  }
  const ch = e.tabuleiro[y][x];
  if (ch !== "." && Damas.dono(ch) === corDe(e, e.eu)) {
    vibrar("erro");
    if (movs.length && movs[0].capturas.length) toast(`Captura obrigatória: coma ${movs[0].capturas.length} peça(s) com uma peça destacada.`);
    else toast("Essa peça não tem lance agora.");
  }
  DS.sel = null;
  DS.parcial = [];
  render();
}

function feedbackDamas(antes, e) {
  const u = e.ultimo;
  if (u && JSON.stringify(u) !== JSON.stringify(antes.ultimo) && u.por !== e.eu && e.eu !== null) {
    vibrar(u.capturas.length ? "aviso" : "light");
  }
  if (antes.fase !== e.fase) {
    if (e.fase === "jogando") {
      vibrar("sucesso");
      toast(e.eu === null ? "♟️ A partida começou!" :
        `♟️ Você joga com as ${NOME_COR[corDe(e, e.eu)]} ${ICONE_COR[corDe(e, e.eu)]}`);
    }
    if (e.fase === "fim" && e.eu !== null) vibrar(e.vencedor === e.eu ? "sucesso" : e.vencedor === null ? "aviso" : "erro");
  } else if (e.fase === "jogando" && antes.vez !== e.vez && e.vez === e.eu) {
    vibrar("medium");
  }
  if (e.empate_proposto !== null && e.empate_proposto !== antes.empate_proposto && e.empate_proposto !== e.eu && e.eu !== null) {
    toast("🤝 O adversário propôs empate");
  }
}

// ---------------------------------------------------------------- treino de damas contra o robô
const DemoDamas = {
  iniciar(_modo, revanche) {
    this.modo = "brasileira";
    this.t = Damas.inicial();
    const brancas = revanche && this.jogadores ? (this.jogadores[0].cor === 0 ? 1 : 0) : (Math.random() < 0.5 ? 0 : 1);
    this.jogadores = [{ nome: "Comandante", cor: brancas === 0 ? 0 : 1 }, { nome: "Robô", cor: brancas === 0 ? 1 : 0 }];
    this.vez = brancas;
    this.fase = "jogando"; this.vencedor = null; this.motivo = null; this.ultimo = null;
    this.lancesDamas = 0; this.empate = null; this.revanche = []; this.proxima = null;
    S.demo = this; S.estado = null; DS.sel = null; DS.parcial = [];
    faixa("Treino contra o robô · não vale para o ranking");
    this.publicar();
    if (this.vez === 1) this.roboJoga();
  },
  movs() { return this.fase === "jogando" ? Damas.movimentos(this.t, this.jogadores[this.vez].cor) : []; },
  jogar(i, mov) {
    const eraDama = Damas.ehDama(this.t[mov.de[1]][mov.de[0]]);
    const virou = Damas.aplicar(this.t, mov);
    this.ultimo = { por: i, de: mov.de, caminho: mov.caminho, capturas: mov.capturas, virou_dama: virou };
    this.lancesDamas = eraDama && !mov.capturas.length ? this.lancesDamas + 1 : 0;
    this.empate = null;
    const adv = 1 - this.jogadores[i].cor;
    const [pd, dm] = Damas.contar(this.t, adv);
    if (pd + dm === 0) { this.fase = "fim"; this.vencedor = i; this.motivo = "sem_pecas"; }
    else {
      this.vez = 1 - i;
      if (!this.movs().length) { this.fase = "fim"; this.vencedor = i; this.motivo = "bloqueado"; }
      else if (this.lancesDamas >= 20) { this.fase = "fim"; this.vencedor = null; this.motivo = "empate_20"; }
    }
    this.publicar();
    if (this.fase === "jogando" && this.vez === 1) this.roboJoga();
  },
  roboJoga() {
    setTimeout(() => {
      if (S.demo !== this || this.fase !== "jogando" || this.vez !== 1) return;
      const ms = this.movs();
      if (!ms.length) return;
      // Prefere virar dama; fora isso, sorteia
      const cor = this.jogadores[1].cor, ultima = cor === 0 ? 0 : 7;
      const viram = ms.filter((m) => !Damas.ehDama(this.t[m.de[1]][m.de[0]]) && m.caminho[m.caminho.length - 1][1] === ultima);
      const lista = viram.length ? viram : ms;
      this.jogar(1, lista[Math.floor(Math.random() * lista.length)]);
    }, 800);
  },
  receber(m) {
    if (m.tipo === "mover") {
      const mov = this.movs().find((x) => mesmaCasa(x.de, m.de) && JSON.stringify(x.caminho) === JSON.stringify(m.caminho));
      if (mov && this.vez === 0) this.jogar(0, mov);
    } else if (m.tipo === "empate") {
      // O robô aceita empate se estiver perdendo em peças
      const [a1, a2] = Damas.contar(this.t, this.jogadores[1].cor), [b1, b2] = Damas.contar(this.t, this.jogadores[0].cor);
      if (a1 + 2 * a2 < b1 + 2 * b2) { this.fase = "fim"; this.vencedor = null; this.motivo = "empate_acordo"; }
      else toast("🤖 O robô recusou o empate.");
      this.publicar();
    } else if (m.tipo === "desistir") {
      this.fase = "fim"; this.vencedor = 1; this.motivo = "desistiu"; this.publicar();
    } else if (m.tipo === "revanche") {
      this.revanche = [0]; this.publicar();
      setTimeout(() => { this.revanche = [0, 1]; this.proxima = "demo2"; this.publicar(); }, 1000);
    }
  },
  publicar() {
    receber({
      jogo: "damas", id: "demo-damas", versao: Date.now() + Math.random(), agora: Date.now() / 1000,
      modo: "brasileira", modo_nome: "Regra brasileira", fase: this.fase, papel: "jogador", eu: 0,
      jogadores: this.jogadores.map((j) => ({ nome: j.nome, cor: j.cor })),
      vez: this.vez, vencedor: this.vencedor, motivo: this.motivo,
      tabuleiro: this.t.map((l) => l.join("")),
      movimentos: this.vez === 0 ? this.movs() : [],
      ultimo: this.ultimo,
      pecas: [Damas.contar(this.t, 0), Damas.contar(this.t, 1)],
      empate_proposto: this.empate, lances_damas: this.lancesDamas, limite_lances_damas: 20,
      reivindicar_em: null, revanche: this.revanche, proxima: this.proxima,
    });
  },
};

// ================================================================ MEMÓRIA
const MS = { vistas: new Set(), precarregadas: "" };   // cartas viradas no último desenho

/** Endereço http(s) do servidor do jogo (mesmo do WebSocket). */
function baseServidor() {
  return (S.url || "").replace(/^ws/, "http").replace(/\/ws$/, "");
}

/** Conteúdo da carta: emoji ou figurinha do pack. */
function figura(e, s) {
  if (!s) return "";
  if (s.startsWith("img:")) {
    return `<img class="fig" src="${baseServidor()}/img/${e.id}/${encodeURIComponent(s.slice(4))}" alt="" draggable="false">`;
  }
  return s;
}

/** Baixa as figurinhas do pack logo no começo, para a carta virar sem atraso. */
function precarregar(e) {
  if (!e.imagens || !e.imagens.length || MS.precarregadas === e.id) return;
  MS.precarregadas = e.id;
  e.imagens.forEach((k) => { const img = new Image(); img.src = `${baseServidor()}/img/${e.id}/${encodeURIComponent(k)}`; });
}

function telaMemoria(e) {
  precarregar(e);
  const pack = e.pack ? ` · 🖼️ ${esc(e.pack.titulo)}` : "";
  let h = `<div class="topo"><div><h1>Memória</h1><small>${esc(e.modo_nome)} · ${2 * e.pares} cartas${pack}</small></div><div class="chip">🧠 Memória</div></div>`;

  if (e.fase === "aguardando") {
    h += `<div class="card centro"><div class="radar"><span></span></div><h2>Aguardando adversário</h2>`;
    if (e.papel === "pode_entrar") {
      h += `<p><b>${esc(e.jogadores[0].nome)}</b> está procurando alguém para jogar.</p></div>
        <button class="b principal" data-b="entrar">🧠 Entrar na partida</button><div class="dica">Quem começa é sorteado.</div>`;
    } else {
      h += `<p>Quem tocar em <b>Abrir jogo</b> na mensagem da partida entra para jogar contra você.</p></div>`;
    }
    if (e.eu === 0) h += `<button class="b perigo" data-b="desistir">Cancelar partida</button>`;
    return h;
  }
  if (e.fase === "cancelada") {
    return h + `<div class="card centro"><div style="font-size:44px">❌</div><h2>Partida cancelada</h2>
      <p>Crie outra com /memoria.</p></div><button class="b fino" data-b="fechar">Fechar</button>`;
  }

  // placar de pares
  const linha = (i) => {
    const j = e.jogadores[i];
    const vez = e.fase === "jogando" && e.vez === i ? " vez" : "";
    let s = `<span class="ponto d${i}"></span> ${e.placar[i]} par(es)`;
    if (e.fase === "fim" && e.vencedor === i) s = `🏆 Venceu · ${e.placar[i]} par(es)`;
    return `<div class="jog${vez}${i === 1 ? " dir" : ""}"><div class="n">${nomeJog(e, i)}</div><div class="s">${s}</div></div>`;
  };
  h += `<div class="placar">${linha(0)}<div class="vs">VS</div>${linha(1)}</div>`;

  const jogador = e.eu !== null;
  const minha = jogador && e.vez === e.eu && e.fase === "jogando";
  if (e.fase === "jogando") {
    const abertas = e.cartas.filter((c) => c.aberta).length;
    if (!jogador) h += `<div class="status espera">👀 Assistindo · vez de ${esc(e.jogadores[e.vez].nome)}</div>`;
    else if (minha && e.esperando) h += `<div class="status espera">😬 Não foi dessa vez…</div>`;
    else if (minha) h += `<div class="status minha">🎯 Sua vez! ${abertas ? "Vire a 2ª carta" : "Vire 2 cartas"}</div>`;
    else h += `<div class="status espera">⏳ Vez de ${esc(e.jogadores[e.vez].nome)}</div>`;

    const u = e.ultimo;
    let ev = "";
    if (u) {
      const quem = u.por === e.eu ? "Você" : esc(e.jogadores[u.por].nome);
      const simb = u.simbolo && u.simbolo.startsWith("img:") ? `<span class="mini">${figura(e, u.simbolo)}</span>` : u.simbolo;
      ev = u.acertou ? `✨ ${quem} formou um par ${simb}` : `❌ ${quem} errou`;
    }
    h += `<div class="evento">${ev}</div>`;
  } else {
    let emoji = "🏆", titulo, cls = "";
    if (e.vencedor === null) {
      const empate = e.motivo === "empate_pares";
      emoji = empate ? "🤝" : "💤"; titulo = empate ? "Empate" : "Partida encerrada";
    } else if (e.eu === e.vencedor) { titulo = "Vitória!"; cls = "vitoria"; }
    else if (e.eu !== null) { emoji = "💥"; titulo = "Derrota"; cls = "derrota"; }
    else titulo = `${esc(e.jogadores[e.vencedor].nome)} venceu!`;
    const perd = e.vencedor === null ? "" : esc(e.jogadores[1 - e.vencedor].nome);
    const motivo = {
      mais_pares: `Placar: ${Math.max(...e.placar)} × ${Math.min(...e.placar)} pares`,
      empate_pares: `Os dois fizeram ${e.placar[0]} pares.`,
      desistiu: `${perd} desistiu.`,
      tempo: `${perd} ficou sem jogar.`,
      abandonada: "Ninguém jogou por 30 minutos.",
    }[e.motivo] || "";
    h += `<div class="card resultado ${cls}"><div class="emoji">${emoji}</div><h2>${titulo}</h2><p>${motivo}</p></div>`;
    h += blocoRevanche(e);
  }

  // cartas
  const ativo = minha && !e.esperando && !S.enviando;
  h += `<div class="mtab${ativo ? " ativo" : ""}" style="--cols:${e.colunas}">`;
  e.cartas.forEach((c, i) => {
    const cls = ["carta"];
    if (c.s) cls.push("virada");
    if (c.s && !MS.vistas.has(i)) cls.push("recente");
    if (!c.s && MS.vistas.has(i)) cls.push("fechando");
    if (c.dono !== null) cls.push("dono", "d" + c.dono);
    if (c.aberta) cls.push("aberta");
    if (c.aberta && e.esperando) cls.push("errou");
    if (ativo && !c.s) cls.push("pode");
    h += `<div class="${cls.join(" ")}" data-i="${i}"><div class="face">${figura(e, c.s)}</div></div>`;
  });
  h += `</div>`;

  if (e.fase === "jogando") {
    h += `<div id="relogio"></div>`;
    if (jogador) h += `<button class="b perigo" data-b="desistir">🏳️ Desistir</button>`;
  } else {
    h += `<button class="b fino" data-b="fechar">Fechar</button>`;
  }
  return h;
}

function tocarMemoria(i) {
  const e = S.estado;
  if (!e || e.jogo !== "memoria" || e.fase !== "jogando" || e.eu === null) return;
  if (e.vez !== e.eu) return toast("Ainda não é a sua vez.");
  if (e.esperando || S.enviando || e.cartas[i].s) return;
  S.enviando = true;
  vibrar("light");
  enviar({ tipo: "virar", i });
}

function feedbackMemoria(antes, e) {
  const u = e.ultimo;
  if (u && JSON.stringify(u) !== JSON.stringify(antes.ultimo) && e.eu !== null) {
    if (u.por === e.eu) vibrar(u.acertou ? "sucesso" : "erro");
    else if (u.acertou) vibrar("aviso");
  }
  if (antes.fase !== e.fase) {
    if (e.fase === "jogando") {
      vibrar("sucesso");
      toast(e.eu === null ? "🧠 A partida começou!" : e.vez === e.eu ? "🧠 Você começa!" : `🧠 ${e.jogadores[e.vez].nome} começa.`);
    }
    if (e.fase === "fim" && e.eu !== null) vibrar(e.vencedor === e.eu ? "sucesso" : e.vencedor === null ? "aviso" : "erro");
  } else if (e.fase === "jogando" && antes.vez !== e.vez && e.vez === e.eu) {
    vibrar("medium");
  }
}

// ---------------------------------------------------------------- treino da memória contra o robô
const DemoMemoria = {
  SIMBOLOS: ["🐶", "🐱", "🐭", "🐹", "🐰", "🦊", "🐻", "🐼", "🐨", "🐯", "🦁", "🐮", "🐷", "🐸", "🐵", "🐔",
    "🐧", "🦉", "🦄", "🐝", "🦋", "🐢", "🐙", "🦀", "🐬", "🐳", "🍎", "🍓", "🍉", "⭐"],
  iniciar(modo, revanche) {
    const tamanhos = { facil: [8, 4, "Fácil"], medio: [12, 4, "Médio"], dificil: [18, 6, "Difícil"] };
    this.modo = tamanhos[modo] ? modo : "facil";
    const [pares, colunas, nome] = tamanhos[this.modo];
    Object.assign(this, { pares, colunas, nome });
    const simb = this.SIMBOLOS.slice().sort(() => Math.random() - 0.5).slice(0, pares);
    this.cartas = simb.concat(simb).sort(() => Math.random() - 0.5);
    this.dono = this.cartas.map(() => null);
    this.abertas = []; this.esperando = false; this.ultimo = null;
    this.memoria = new Map();   // o que o robô lembra: índice -> símbolo
    this.jogadores = [{ nome: "Comandante" }, { nome: "Robô" }];
    this.vez = revanche ? 1 - (this.primeiro || 0) : (Math.random() < 0.5 ? 0 : 1);
    this.primeiro = this.vez;
    this.fase = "jogando"; this.vencedor = null; this.motivo = null; this.revanche = []; this.proxima = null;
    S.demo = this; S.estado = null; MS.vistas = new Set();
    faixa("Treino contra o robô · não vale para o ranking");
    this.publicar();
    if (this.vez === 1) this.roboJoga();
  },
  placar() { return [0, 1].map((i) => this.dono.filter((d) => d === i).length / 2); },
  lembrar(k) { if (Math.random() < 0.5) this.memoria.set(k, this.cartas[k]); },  // robô lembra metade do que vê
  virar(i, k) {
    if (this.fase !== "jogando" || this.vez !== i || this.esperando || this.dono[k] !== null || this.abertas.includes(k)) return;
    this.abertas.push(k);
    this.lembrar(k);
    if (this.abertas.length === 2) {
      const [a, b] = this.abertas, acertou = this.cartas[a] === this.cartas[b];
      this.ultimo = { por: i, a, b, acertou, simbolo: this.cartas[a] };
      if (acertou) {
        this.dono[a] = this.dono[b] = i; this.abertas = [];
        this.memoria.delete(a); this.memoria.delete(b);
        if (this.dono.every((d) => d !== null)) {
          const p = this.placar();
          this.fase = "fim";
          this.vencedor = p[0] === p[1] ? null : p[0] > p[1] ? 0 : 1;
          this.motivo = p[0] === p[1] ? "empate_pares" : "mais_pares";
        }
        this.publicar();
        if (this.fase === "jogando" && this.vez === 1) this.roboJoga();
        return;
      }
      this.esperando = true;
      this.publicar();
      setTimeout(() => {
        if (S.demo !== this) return;
        this.abertas = []; this.esperando = false; this.vez = 1 - this.vez;
        this.publicar();
        if (this.fase === "jogando" && this.vez === 1) this.roboJoga();
      }, 1800);
      return;
    }
    this.publicar();
  },
  roboJoga() {
    const livres = () => this.cartas.map((_, k) => k).filter((k) => this.dono[k] === null && !this.abertas.includes(k));
    const sorteia = (lista) => lista[Math.floor(Math.random() * lista.length)];
    const desconhecidas = () => livres().filter((k) => !this.memoria.has(k));
    // 1) já conhece um par inteiro?
    let a = null, b = null;
    const vistos = {};
    for (const [k, s] of this.memoria) {
      if (this.dono[k] !== null) continue;
      if (vistos[s] !== undefined) { a = vistos[s]; b = k; break; }
      vistos[s] = k;
    }
    setTimeout(() => {
      if (S.demo !== this || this.fase !== "jogando" || this.vez !== 1) return;
      if (a === null) a = sorteia(desconhecidas().length ? desconhecidas() : livres());
      this.virar(1, a);
      setTimeout(() => {
        if (this.fase !== "jogando" || this.vez !== 1 || this.abertas.length !== 1) return;
        if (b === null) {
          const par = [...this.memoria].find(([k, s]) => k !== a && s === this.cartas[a] && this.dono[k] === null);
          const resto = livres().filter((k) => k !== a);
          const novas = resto.filter((k) => !this.memoria.has(k));
          b = par ? par[0] : sorteia(novas.length ? novas : resto);
        }
        this.virar(1, b);
      }, 900);
    }, 900);
  },
  receber(m) {
    if (m.tipo === "virar") this.virar(0, m.i);
    else if (m.tipo === "desistir") { this.fase = "fim"; this.vencedor = 1; this.motivo = "desistiu"; this.publicar(); }
    else if (m.tipo === "revanche") {
      this.revanche = [0]; this.publicar();
      setTimeout(() => { this.revanche = [0, 1]; this.proxima = "demo2"; this.publicar(); }, 1000);
    }
  },
  publicar() {
    const fim = this.fase === "fim";
    receber({
      jogo: "memoria", id: "demo-memoria", versao: Date.now() + Math.random(), agora: Date.now() / 1000,
      modo: this.modo, modo_nome: this.nome, fase: this.fase, papel: "jogador", eu: 0,
      jogadores: this.jogadores, vez: this.vez, vencedor: this.vencedor, motivo: this.motivo,
      pares: this.pares, colunas: this.colunas, placar: this.placar(), ultimo: this.ultimo, esperando: this.esperando,
      cartas: this.cartas.map((s, k) => ({
        s: this.dono[k] !== null || this.abertas.includes(k) || fim ? s : null,
        dono: this.dono[k], aberta: this.abertas.includes(k),
      })),
      reivindicar_em: null, revanche: this.revanche, proxima: this.proxima,
    });
  },
};

// ================================================================ PONTINHOS
const CORES_J = ["#38bdf8", "#fb923c"];

function desenharPontinhos(e, ativo) {
  const n = e.tam, P = 100, M = 24, L = n * P + 2 * M;
  const x = (c) => M + c * P, y = (r) => M + r * P;
  const u = e.ultimo;
  const fechadas = new Set(u ? u.fechou.map(([r, c]) => r + "," + c) : []);
  let svg = `<svg class="ptab${ativo ? " ativo" : ""}" viewBox="0 0 ${L} ${L}" xmlns="http://www.w3.org/2000/svg">`;

  // quadradinhos com dono
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    const d = e.caixas[r][c];
    if (d === null) continue;
    const ini = esc((e.jogadores[d].nome || "?").trim().charAt(0).toUpperCase());
    svg += `<rect class="caixa${fechadas.has(r + "," + c) ? " nova" : ""}" x="${x(c) + 6}" y="${y(r) + 6}" width="${P - 12}" height="${P - 12}" rx="10" fill="${CORES_J[d]}" />`;
    svg += `<text class="inicial" x="${x(c) + P / 2}" y="${y(r) + P / 2}" >${ini}</text>`;
  }

  const linha = (t, r, c, x1, y1, x2, y2) => {
    const dono = (t === "h" ? e.h : e.v)[r][c];
    const ultima = u && u.t === t && u.r === r && u.c === c;
    if (dono !== null) {
      return `<line class="traco${ultima ? " ultima" : ""}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${CORES_J[dono]}" />`;
    }
    let h = `<line class="vazia" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" />`;
    if (ativo) h += `<line class="alvo-linha" data-lt="${t}" data-r="${r}" data-c="${c}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" />`;
    return h;
  };
  for (let r = 0; r <= n; r++) for (let c = 0; c < n; c++) svg += linha("h", r, c, x(c), y(r), x(c + 1), y(r));
  for (let r = 0; r < n; r++) for (let c = 0; c <= n; c++) svg += linha("v", r, c, x(c), y(r), x(c), y(r + 1));

  for (let r = 0; r <= n; r++) for (let c = 0; c <= n; c++) svg += `<circle class="ponto-p" cx="${x(c)}" cy="${y(r)}" r="9" />`;
  return svg + "</svg>";
}

function telaPontinhos(e) {
  let h = `<div class="topo"><div><h1>Pontinhos</h1><small>${esc(e.modo_nome)} · ${e.tam}x${e.tam} quadradinhos</small></div><div class="chip">🔲 Pontinhos</div></div>`;

  if (e.fase === "aguardando") {
    h += `<div class="card centro"><div class="radar"><span></span></div><h2>Aguardando adversário</h2>`;
    if (e.papel === "pode_entrar") {
      h += `<p><b>${esc(e.jogadores[0].nome)}</b> está procurando alguém para jogar.</p></div>
        <button class="b principal" data-b="entrar">🔲 Entrar na partida</button><div class="dica">Quem começa é sorteado.</div>`;
    } else {
      h += `<p>Quem tocar em <b>Abrir jogo</b> na mensagem da partida entra para jogar contra você.</p></div>`;
    }
    if (e.eu === 0) h += `<button class="b perigo" data-b="desistir">Cancelar partida</button>`;
    return h;
  }
  if (e.fase === "cancelada") {
    return h + `<div class="card centro"><div style="font-size:44px">❌</div><h2>Partida cancelada</h2>
      <p>Crie outra com /pontinhos.</p></div><button class="b fino" data-b="fechar">Fechar</button>`;
  }

  const linhaJ = (i) => {
    const vez = e.fase === "jogando" && e.vez === i ? " vez" : "";
    let s = `<span class="ponto d${i}"></span> ${e.placar[i]} quadradinho(s)`;
    if (e.fase === "fim" && e.vencedor === i) s = `🏆 Venceu · ${e.placar[i]}`;
    return `<div class="jog${vez}${i === 1 ? " dir" : ""}"><div class="n">${nomeJog(e, i)}</div><div class="s">${s}</div></div>`;
  };
  h += `<div class="placar">${linhaJ(0)}<div class="vs">VS</div>${linhaJ(1)}</div>`;

  const jogador = e.eu !== null;
  const minha = jogador && e.fase === "jogando" && e.vez === e.eu;
  if (e.fase === "jogando") {
    if (!jogador) h += `<div class="status espera">👀 Assistindo · vez de ${esc(e.jogadores[e.vez].nome)}</div>`;
    else if (minha) h += `<div class="status minha">🎯 Sua vez! Ligue dois pontos</div>`;
    else h += `<div class="status espera">⏳ Vez de ${esc(e.jogadores[e.vez].nome)}</div>`;
    const u = e.ultimo;
    let ev = "";
    if (u) {
      const quem = u.por === e.eu ? "Você" : esc(e.jogadores[u.por].nome);
      ev = u.fechou.length ? `✨ ${quem} fechou ${u.fechou.length} quadradinho(s) e joga de novo` : `✏️ ${quem} traçou uma linha`;
    }
    const total = e.tam * e.tam, livres = total - e.placar[0] - e.placar[1];
    h += `<div class="evento">${ev}</div>`;
    h += desenharPontinhos(e, minha && !S.enviando);
    h += `<div class="dica">${livres} quadradinho(s) em disputa</div><div id="relogio"></div>`;
    if (jogador) h += `<button class="b perigo" data-b="desistir">🏳️ Desistir</button>`;
    return h;
  }

  let emoji = "🏆", titulo, cls = "";
  if (e.vencedor === null) {
    const empate = e.motivo === "empate_quadrados";
    emoji = empate ? "🤝" : "💤"; titulo = empate ? "Empate" : "Partida encerrada";
  } else if (e.eu === e.vencedor) { titulo = "Vitória!"; cls = "vitoria"; }
  else if (e.eu !== null) { emoji = "💥"; titulo = "Derrota"; cls = "derrota"; }
  else titulo = `${esc(e.jogadores[e.vencedor].nome)} venceu!`;
  const perd = e.vencedor === null ? "" : esc(e.jogadores[1 - e.vencedor].nome);
  const motivo = {
    mais_quadrados: `Placar: ${Math.max(...e.placar)} × ${Math.min(...e.placar)} quadradinhos`,
    empate_quadrados: `Os dois fecharam ${e.placar[0]} quadradinhos.`,
    desistiu: `${perd} desistiu.`,
    tempo: `${perd} ficou sem jogar.`,
    abandonada: "Ninguém jogou por muito tempo.",
  }[e.motivo] || "";
  h += `<div class="card resultado ${cls}"><div class="emoji">${emoji}</div><h2>${titulo}</h2><p>${motivo}</p></div>`;
  h += blocoRevanche(e);
  h += desenharPontinhos(e, false);
  return h + `<button class="b fino" data-b="fechar">Fechar</button>`;
}

function tocarPontinhos(t, r, c) {
  const e = S.estado;
  if (!e || e.jogo !== "pontinhos" || e.fase !== "jogando" || e.eu === null) return;
  if (e.vez !== e.eu) return toast("Ainda não é a sua vez.");
  if (S.enviando || (t === "h" ? e.h : e.v)[r][c] !== null) return;
  S.enviando = true;
  vibrar("light");
  enviar({ tipo: "linha", t, r, c });
}

function feedbackPontinhos(antes, e) {
  const u = e.ultimo;
  if (u && JSON.stringify(u) !== JSON.stringify(antes.ultimo) && e.eu !== null) {
    if (u.fechou.length) vibrar(u.por === e.eu ? "sucesso" : "aviso");
  }
  if (antes.fase !== e.fase) {
    if (e.fase === "jogando") {
      vibrar("sucesso");
      toast(e.eu === null ? "🔲 A partida começou!" : e.vez === e.eu ? "🔲 Você começa!" : `🔲 ${e.jogadores[e.vez].nome} começa.`);
    }
    if (e.fase === "fim" && e.eu !== null) vibrar(e.vencedor === e.eu ? "sucesso" : e.vencedor === null ? "aviso" : "erro");
  } else if (e.fase === "jogando" && antes.vez !== e.vez && e.vez === e.eu) {
    vibrar("medium");
  }
}

// ---------------------------------------------------------------- treino do pontinhos contra o robô
const DemoPontinhos = {
  iniciar(modo, revanche) {
    const tamanhos = { pequeno: [4, "Pequeno"], medio: [6, "Médio"], grande: [8, "Grande"] };
    this.modo = tamanhos[modo] ? modo : "pequeno";
    [this.tam, this.nome] = tamanhos[this.modo];
    const n = this.tam;
    this.h = Array.from({ length: n + 1 }, () => Array(n).fill(null));
    this.v = Array.from({ length: n }, () => Array(n + 1).fill(null));
    this.caixas = Array.from({ length: n }, () => Array(n).fill(null));
    this.jogadores = [{ nome: "Comandante" }, { nome: "Robô" }];
    this.vez = revanche ? 1 - (this.primeiro || 0) : (Math.random() < 0.5 ? 0 : 1);
    this.primeiro = this.vez;
    this.fase = "jogando"; this.vencedor = null; this.motivo = null; this.ultimo = null;
    this.revanche = []; this.proxima = null;
    S.demo = this; S.estado = null;
    faixa("Treino contra o robô · não vale para o ranking");
    this.publicar();
    if (this.vez === 1) this.roboJoga();
  },
  lados(r, c) {
    return [this.h[r][c], this.h[r + 1][c], this.v[r][c], this.v[r][c + 1]].filter((x) => x !== null).length;
  },
  vizinhas(t, r, c) {
    const n = this.tam, lista = t === "h" ? [[r - 1, c], [r, c]] : [[r, c - 1], [r, c]];
    return lista.filter(([a, b]) => a >= 0 && b >= 0 && a < n && b < n);
  },
  livres() {
    const n = this.tam, l = [];
    for (let r = 0; r <= n; r++) for (let c = 0; c < n; c++) if (this.h[r][c] === null) l.push(["h", r, c]);
    for (let r = 0; r < n; r++) for (let c = 0; c <= n; c++) if (this.v[r][c] === null) l.push(["v", r, c]);
    return l;
  },
  placar() { return [0, 1].map((i) => this.caixas.flat().filter((d) => d === i).length); },
  jogar(i, t, r, c) {
    const g = t === "h" ? this.h : this.v;
    if (this.fase !== "jogando" || this.vez !== i || g[r][c] !== null) return;
    g[r][c] = i;
    const fechou = this.vizinhas(t, r, c).filter(([a, b]) => this.caixas[a][b] === null && this.lados(a, b) === 4);
    fechou.forEach(([a, b]) => (this.caixas[a][b] = i));
    this.ultimo = { por: i, t, r, c, fechou };
    if (this.caixas.flat().every((d) => d !== null)) {
      const p = this.placar();
      this.fase = "fim";
      this.vencedor = p[0] === p[1] ? null : p[0] > p[1] ? 0 : 1;
      this.motivo = p[0] === p[1] ? "empate_quadrados" : "mais_quadrados";
    } else if (!fechou.length) {
      this.vez = 1 - i;
    }
    this.publicar();
    if (this.fase === "jogando" && this.vez === 1) this.roboJoga();
  },
  roboJoga() {
    setTimeout(() => {
      if (S.demo !== this || this.fase !== "jogando" || this.vez !== 1) return;
      const livres = this.livres();
      const sorteia = (l) => l[Math.floor(Math.random() * l.length)];
      // 1) fecha quadradinho se puder; 2) linha que não entrega o 3º lado; 3) qualquer uma
      const fecha = livres.filter(([t, r, c]) => this.vizinhas(t, r, c).some(([a, b]) => this.lados(a, b) === 3));
      const segura = livres.filter(([t, r, c]) => this.vizinhas(t, r, c).every(([a, b]) => this.lados(a, b) < 2));
      const [t, r, c] = sorteia(fecha.length ? fecha : segura.length ? segura : livres);
      this.jogar(1, t, r, c);
    }, 700);
  },
  receber(m) {
    if (m.tipo === "linha") this.jogar(0, m.t, m.r, m.c);
    else if (m.tipo === "desistir") { this.fase = "fim"; this.vencedor = 1; this.motivo = "desistiu"; this.publicar(); }
    else if (m.tipo === "revanche") {
      this.revanche = [0]; this.publicar();
      setTimeout(() => { this.revanche = [0, 1]; this.proxima = "demo2"; this.publicar(); }, 1000);
    }
  },
  publicar() {
    receber({
      jogo: "pontinhos", id: "demo-pontinhos", versao: Date.now() + Math.random(), agora: Date.now() / 1000,
      modo: this.modo, modo_nome: this.nome, fase: this.fase, papel: "jogador", eu: 0,
      jogadores: this.jogadores, vez: this.vez, vencedor: this.vencedor, motivo: this.motivo,
      tam: this.tam, h: this.h, v: this.v, caixas: this.caixas, placar: this.placar(), ultimo: this.ultimo,
      reivindicar_em: null, revanche: this.revanche, proxima: this.proxima, assistindo: 0,
    });
  },
};

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
    else if (d.tipo === "erro") {
      S.enviando = false; DS.sel = null; DS.parcial = [];
      vibrar("erro"); toast(d.msg, "erro");
      if (S.estado) render();
    }
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
  Som.iniciar();
  if (tg) {
    tg.ready();
    tg.expand();
    try { tg.setHeaderColor("#0d1733"); tg.setBackgroundColor("#070d1f"); } catch (e) { /* versões antigas */ }
  }
  const q = new URLSearchParams(location.search);
  if (q.has("demo")) return Demo.iniciar(q.get("demo"));

  const { id, sub } = lerParam();
  // Aberto pelo perfil do bot (ou fora do Telegram): mostra regras, aviso VIP e treino
  if (!id || !tg || !tg.initData) return telaBoasVindas();
  S.url = sub ? `wss://${sub}.trycloudflare.com/ws` : (window.CONFIG && CONFIG.SERVIDOR_PADRAO);
  if (!S.url) return telaErro("Endereço do servidor não configurado.");
  S.partida = id;
  conectar();
}

// ---------------------------------------------------------------- modo demonstração (?demo)
// Joga contra um robô sem precisar do bot ligado. Útil para testar o visual.
const Demo = {
  iniciar(modo, revanche) {
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
    this.revanche = []; this.proxima = null;
    S.demo = this;
    S.estado = null;
    S.editor = null;
    faixa("Treino contra o robô · não vale para o ranking");
    if (revanche) { this.fase = "posicionando"; this.publicar(); return this.roboPosiciona(); }
    this.publicar();
    setTimeout(() => { this.fase = "posicionando"; this.publicar(); this.roboPosiciona(); }, 1800);
  },
  roboPosiciona() {
    setTimeout(() => {
      if (S.demo !== this || this.fase !== "posicionando") return;
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
      if (S.demo !== this || this.fase !== "batalha" || this.vez !== 1) return;
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
    } else if (m.tipo === "revanche") {
      this.revanche = [0];
      this.publicar();
      setTimeout(() => { this.revanche = [0, 1]; this.proxima = "demo2"; this.publicar(); }, 1200);
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
      revanche: this.revanche, proxima: this.proxima,
    });
  },
};

iniciar();
