"use strict";
/* Motor das Damas (regra brasileira) — mesma lógica do damas.py do servidor.
   Usado no treino contra o robô. Tabuleiro: array de 8 linhas com 8 caracteres
   ".", "b" (pedra branca), "B" (dama branca), "p" (pedra preta), "P" (dama preta).
   x = coluna (0 esquerda), y = linha (0 em cima). Brancas embaixo, sobem. */
const Damas = (() => {
  const TAM = 8, BRANCAS = 0, PRETAS = 1;
  const DIAG = [[-1, -1], [1, -1], [-1, 1], [1, 1]];

  const dono = (c) => (c === "b" || c === "B") ? BRANCAS : (c === "p" || c === "P") ? PRETAS : null;
  const ehDama = (c) => c === "B" || c === "P";
  const dentro = (x, y) => x >= 0 && y >= 0 && x < TAM && y < TAM;
  const temCasa = (lista, x, y) => lista.some(([a, b]) => a === x && b === y);

  function inicial() {
    const t = [];
    for (let y = 0; y < TAM; y++) {
      const linha = [];
      for (let x = 0; x < TAM; x++) {
        linha.push((x + y) % 2 === 1 ? (y <= 2 ? "p" : y >= 5 ? "b" : ".") : ".");
      }
      t.push(linha);
    }
    return t;
  }

  function capturasDaPeca(t, x, y) {
    const peca = t[y][x], cor = dono(peca), dama = ehDama(peca);
    const res = [];
    t[y][x] = ".";
    const dfs = (cx, cy, caminho, capt) => {
      let continuou = false;
      for (const [dx, dy] of DIAG) {
        if (dama) {
          let nx = cx + dx, ny = cy + dy;
          while (dentro(nx, ny) && t[ny][nx] === ".") { nx += dx; ny += dy; }
          if (!dentro(nx, ny)) continue;
          if (dono(t[ny][nx]) !== 1 - cor || temCasa(capt, nx, ny)) continue;
          let lx = nx + dx, ly = ny + dy;
          while (dentro(lx, ly) && t[ly][lx] === ".") {
            continuou = true;
            dfs(lx, ly, caminho.concat([[lx, ly]]), capt.concat([[nx, ny]]));
            lx += dx; ly += dy;
          }
        } else {
          const mx = cx + dx, my = cy + dy, lx = cx + 2 * dx, ly = cy + 2 * dy;
          if (dentro(lx, ly) && t[ly][lx] === "." && dono(t[my][mx]) === 1 - cor && !temCasa(capt, mx, my)) {
            continuou = true;
            dfs(lx, ly, caminho.concat([[lx, ly]]), capt.concat([[mx, my]]));
          }
        }
      }
      if (!continuou && caminho.length) res.push({ caminho, capturas: capt });
    };
    try { dfs(x, y, [], []); } finally { t[y][x] = peca; }
    return res;
  }

  function movimentos(t, cor) {
    const capturas = [], simples = [];
    const frente = cor === BRANCAS ? -1 : 1;
    for (let y = 0; y < TAM; y++) {
      for (let x = 0; x < TAM; x++) {
        if (dono(t[y][x]) !== cor) continue;
        for (const c of capturasDaPeca(t, x, y)) capturas.push({ de: [x, y], caminho: c.caminho, capturas: c.capturas });
        if (capturas.length) continue;
        if (ehDama(t[y][x])) {
          for (const [dx, dy] of DIAG) {
            let nx = x + dx, ny = y + dy;
            while (dentro(nx, ny) && t[ny][nx] === ".") {
              simples.push({ de: [x, y], caminho: [[nx, ny]], capturas: [] });
              nx += dx; ny += dy;
            }
          }
        } else {
          for (const dx of [-1, 1]) {
            const nx = x + dx, ny = y + frente;
            if (dentro(nx, ny) && t[ny][nx] === ".") simples.push({ de: [x, y], caminho: [[nx, ny]], capturas: [] });
          }
        }
      }
    }
    if (capturas.length) {
      const max = Math.max(...capturas.map((m) => m.capturas.length));
      return capturas.filter((m) => m.capturas.length === max);
    }
    return simples;
  }

  /** Aplica o lance (altera t). Devolve true se virou dama. */
  function aplicar(t, mov) {
    const [x, y] = mov.de;
    let peca = t[y][x];
    t[y][x] = ".";
    for (const [cx, cy] of mov.capturas) t[cy][cx] = ".";
    const [fx, fy] = mov.caminho[mov.caminho.length - 1];
    let virou = false;
    if (peca === "b" && fy === 0) { peca = "B"; virou = true; }
    else if (peca === "p" && fy === TAM - 1) { peca = "P"; virou = true; }
    t[fy][fx] = peca;
    return virou;
  }

  function contar(t, cor) {
    let pedras = 0, damas = 0;
    for (const linha of t) for (const c of linha) {
      if (dono(c) === cor) { if (ehDama(c)) damas++; else pedras++; }
    }
    return [pedras, damas];
  }

  const notacao = (x, y) => "abcdefgh"[x] + (TAM - y);

  return { TAM, BRANCAS, PRETAS, inicial, movimentos, aplicar, contar, dono, ehDama, notacao };
})();

if (typeof module !== "undefined") module.exports = Damas;
