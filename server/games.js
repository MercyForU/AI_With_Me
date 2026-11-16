/**
 * 小游戏的「大脑」：让当前聊天模型以角色身份做决策，并在一局结束后写总结。
 *
 * 为什么不让模型直接下五子棋：语言模型看棋盘经常走瞎棋（坐标算错、看不见活四）。
 * 所以这里做「模型出主意 + 规则兜底」：
 *   - 能一手赢 → 直接赢；对方下一手能赢 → 必须堵；
 *   - 其余情况用模型给的点，非法才退回启发式评分。
 * 这样既有角色性格（走法、台词），又不会下出让人出戏的棋。
 */

const GAME_LABEL = { rps: '石头剪刀布', gomoku: '五子棋' };
const MOVES = ['rock', 'scissors', 'paper'];

function personaOf(character, userName) {
  const lines = [
    `你是「${character.name}」，正在和${userName ? `「${userName}」` : '对方'}玩游戏。`,
  ];
  if (character.tagline) lines.push(`你的一句话人设：${character.tagline}`);
  if (character.personality) lines.push(`你的性格：${String(character.personality).slice(0, 300)}`);
  lines.push('说话保持这个角色：口语化、短句、不要提自己是 AI 或模型，不要解释规则。');
  return lines.join('\n');
}

function parseJson(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  // 模型常把 JSON 包在代码块或解释里，抓第一个 { 到最后一个 }
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

function cleanTalk(talk) {
  const t = String(talk || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/^["'「]|["'」]$/g, '')
    .trim();
  return t.length > 40 ? `${t.slice(0, 40)}…` : t;
}

// ---------- 五子棋的规则兜底 ----------
const DIRS = [
  [1, 0],
  [0, 1],
  [1, 1],
  [1, -1],
];

function inBoard(board, x, y) {
  return y >= 0 && y < board.length && x >= 0 && x < board.length;
}

/** 在 (x,y) 落 who 之后，这条线上能连成几个（含两端开放度） */
function lineScore(board, x, y, who) {
  let total = 0;
  for (const [dx, dy] of DIRS) {
    let count = 1;
    let open = 0;
    for (const sign of [1, -1]) {
      for (let i = 1; i < 5; i++) {
        const nx = x + dx * i * sign;
        const ny = y + dy * i * sign;
        if (!inBoard(board, nx, ny)) break;
        const v = board[ny][nx];
        if (v === who) {
          count += 1;
        } else {
          if (v === 0) open += 1;
          break;
        }
      }
    }
    if (count >= 5) total += 100000;
    else total += [0, 2, 12, 90, 800][count] + open * 6;
  }
  return total;
}

/** 落子后是否直接五连 */
function isWinningMove(board, x, y, who) {
  for (const [dx, dy] of DIRS) {
    let count = 1;
    for (const sign of [1, -1]) {
      for (let i = 1; i < 5; i++) {
        const nx = x + dx * i * sign;
        const ny = y + dy * i * sign;
        if (!inBoard(board, nx, ny) || board[ny][nx] !== who) break;
        count += 1;
      }
    }
    if (count >= 5) return true;
  }
  return false;
}

function emptyPoints(board) {
  const list = [];
  for (let y = 0; y < board.length; y++) {
    for (let x = 0; x < board.length; x++) {
      if (board[y][x] === 0) list.push([x, y]);
    }
  }
  return list;
}

function findWinningPoint(board, who) {
  for (const [x, y] of emptyPoints(board)) {
    if (isWinningMove(board, x, y, who)) return { x, y };
  }
  return null;
}

function bestByScore(board, who) {
  let best = null;
  let bestScore = -1;
  for (const [x, y] of emptyPoints(board)) {
    // 既看自己的进攻，也看对方的威胁
    const score = lineScore(board, x, y, who) + lineScore(board, x, y, who === 1 ? 2 : 1) * 0.9;
    if (score > bestScore) {
      bestScore = score;
      best = { x, y };
    }
  }
  return best;
}

/** 把棋盘画成模型能读的样子 */
function boardText(board) {
  const size = board.length;
  const header = `   ${Array.from({ length: size }, (_, i) => String(i).padStart(2)).join('')}`;
  const rows = board.map((row, y) => `${String(y).padStart(2)} ${row.map((v) => (v === 0 ? '·' : v === 1 ? '●' : '○')).join(' ')}`);
  return [header, ...rows].join('\n');
}

// ---------- 对外的两个动作 ----------
const CHOOSE_TOOL = {
  type: 'function',
  function: {
    name: 'play_move',
    description: '在游戏里做出你的选择',
    parameters: {
      type: 'object',
      properties: {
        move: { type: 'string', description: '石头剪刀布：rock / scissors / paper；五子棋留空' },
        x: { type: 'number', description: '五子棋横坐标 0-8' },
        y: { type: 'number', description: '五子棋纵坐标 0-8' },
        talk: { type: 'string', description: '想对对方说的一句话，20 字以内，可以留空' },
      },
      required: [],
    },
  },
};

/**
 * 让模型做一次决策。
 * @returns {{ move: any, talk: string, source: 'model' | 'heuristic' }}
 */
async function decide({ character, game, state, userName, llm, providers }) {
  const resolved = providers.resolveForChat(character);

  // 五子棋先算规则兜底，模型只在没有必胜/必防时给主意
  let board = null;
  let forced = null;
  if (game === 'gomoku') {
    board = state.board;
    const win = findWinningPoint(board, 2);
    if (win) forced = { ...win, talk: '' };
    else {
      const block = findWinningPoint(board, 1);
      if (block) forced = { ...block, talk: '' };
    }
  }

  let modelMove = null;
  let talk = '';

  if (resolved) {
    const brief =
      game === 'rps'
        ? [
            `你们在玩${GAME_LABEL.rps}，三局两胜。`,
            `当前比分：你 ${state.aiWins ?? 0} 胜，对方 ${state.userWins ?? 0} 胜，这是第 ${(state.round ?? 0) + 1} 局。`,
            state.history?.length
              ? `前几局：${state.history.map((h) => `对方出${h.user}，你出${h.ai}（${h.outcome}）`).join('；')}`
              : '这是第一局。',
            '现在同时出手：你想出什么？返回 {"move":"rock|scissors|paper","talk":"一句话"}。',
          ].join('\n')
        : [
            `你们在下${GAME_LABEL.gomoku}（9×9，你执白○，对方执黑●，五连即胜）。`,
            '棋盘（·空位，●对方的子，○你的子）：',
            boardText(board),
            state.lastMove ? `对方最近一手：(${state.lastMove.x},${state.lastMove.y})。` : '对方还没落子。',
            forced
              ? `注意：现在必须下在 (${forced.x},${forced.y}) 才能${isWinningMove(board, forced.x, forced.y, 2) ? '直接连成五子' : '挡住对方的五连'}。`
              : '想一个位置落子，必须是空位。',
            '返回 {"x":横坐标,"y":纵坐标,"talk":"一句话"}，坐标用 0-8 的数字。',
          ].join('\n');

    try {
      const out = await llm.completeOnce({
        provider: resolved.config,
        model: resolved.model,
        messages: [
          { role: 'system', content: personaOf(character, userName) },
          { role: 'user', content: brief },
        ],
      });
      const parsed = parseJson(out);
      if (parsed) {
        talk = cleanTalk(parsed.talk);
        if (game === 'rps') {
          const m = String(parsed.move || '').toLowerCase();
          if (MOVES.includes(m)) modelMove = m;
        } else {
          const x = Number(parsed.x);
          const y = Number(parsed.y);
          if (Number.isInteger(x) && Number.isInteger(y) && inBoard(board, x, y) && board[y][x] === 0) {
            modelMove = { x, y };
          }
        }
      }
    } catch (e) {
      console.warn('[game] 模型决策失败，改用规则：', e.message);
    }
  }

  if (game === 'rps') {
    if (modelMove) return { move: modelMove, talk, source: 'model' };
    return { move: MOVES[Math.floor(Math.random() * 3)], talk, source: 'heuristic' };
  }

  if (forced) return { move: { x: forced.x, y: forced.y }, talk, source: 'heuristic' };
  if (modelMove) return { move: modelMove, talk, source: 'model' };
  return { move: bestByScore(board, 2) || emptyPoints(board)[0], talk, source: 'heuristic' };
}

/**
 * 一局结束：让模型用角色口吻写一句话，另外生成一条事实性记忆。
 */
async function finish({ character, game, result, note, userName, llm, providers }) {
  const label = GAME_LABEL[game] || '游戏';
  const factual = `和${userName || '对方'}玩了一局${label}${note ? `，${note}` : ''}，结果是${
    result === 'win' ? '对方赢了' : result === 'lose' ? '自己赢了' : '平局'
  }。`;

  const resolved = providers.resolveForChat(character);
  let line = '';
  if (resolved) {
    try {
      const out = await llm.completeOnce({
        provider: resolved.config,
        model: resolved.model,
        messages: [
          { role: 'system', content: personaOf(character, userName) },
          {
            role: 'user',
            content: `你们刚玩完一局${label}，${note || ''}结果：${
              result === 'win' ? '对方赢了' : result === 'lose' ? '你赢了' : '平局'
            }。用一句话说说你现在的心情或想对对方说的话，20 字以内，不要解释、不要加引号。`,
          },
        ],
      });
      line = cleanTalk(out);
    } catch (e) {
      console.warn('[game] 结束语生成失败：', e.message);
    }
  }

  return { factual, line: line || `（我们刚玩了一局${label}，${note || ''}）` };
}

module.exports = { decide, finish, GAME_LABEL };
