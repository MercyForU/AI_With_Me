/**
 * 手机版小游戏的「大脑」，与 server/games.js 保持同一套规则兜底：
 * 模型出主意，能赢/必须堵的情况由规则强制。
 */
import { chatOnce } from './llm';
import { currentModel, rawProvider, now } from './data';

const GAME_LABEL: Record<string, string> = { rps: '石头剪刀布', gomoku: '五子棋' };
const MOVES = ['rock', 'scissors', 'paper'];
const DIRS = [
  [1, 0],
  [0, 1],
  [1, 1],
  [1, -1],
];

type Board = number[][];

function personaOf(c: { name: string; tagline?: string | null; personality?: string | null }, userName: string) {
  const lines = [`你是「${c.name}」，正在和${userName ? `「${userName}」` : '对方'}玩游戏。`];
  if (c.tagline) lines.push(`你的一句话人设：${c.tagline}`);
  if (c.personality) lines.push(`你的性格：${String(c.personality).slice(0, 300)}`);
  lines.push('说话保持这个角色：口语化、短句、不要提自己是 AI 或模型，不要解释规则。');
  return lines.join('\n');
}

async function ask(prompt: string, c: { name: string; tagline?: string | null; personality?: string | null }, userName: string) {
  const cur = await currentModel();
  if (!cur) return '';
  const row = await rawProvider(cur.providerId);
  if (!row) return '';
  const config = {
    type: (row.type === 'ollama' ? 'ollama' : 'openai') as 'openai' | 'ollama',
    baseUrl: row.base_url,
    apiKey: row.api_key,
  };
  if (config.type === 'openai' && !config.apiKey) return '';
  try {
    const r = await chatOnce({
      provider: config,
      model: cur.model,
      messages: [
        { role: 'system', content: personaOf(c, userName) },
        { role: 'user', content: prompt },
      ],
    });
    return r.text;
  } catch {
    return '';
  }
}

function parseJson(text: string): Record<string, unknown> | null {
  const raw = String(text || '').trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

function cleanTalk(talk: unknown) {
  const t = String(talk || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/^["'「]|["'」]$/g, '')
    .trim();
  return t.length > 40 ? `${t.slice(0, 40)}…` : t;
}

function inBoard(board: Board, x: number, y: number) {
  return y >= 0 && y < board.length && x >= 0 && x < board.length;
}

function isWinningMove(board: Board, x: number, y: number, who: number) {
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

function emptyPoints(board: Board) {
  const list: Array<[number, number]> = [];
  board.forEach((row, y) =>
    row.forEach((v, x) => {
      if (v === 0) list.push([x, y]);
    }),
  );
  return list;
}

function findWinningPoint(board: Board, who: number) {
  for (const [x, y] of emptyPoints(board)) {
    if (isWinningMove(board, x, y, who)) return { x, y };
  }
  return null;
}

function lineScore(board: Board, x: number, y: number, who: number) {
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
        if (v === who) count += 1;
        else {
          if (v === 0) open += 1;
          break;
        }
      }
    }
    total += (count >= 5 ? 100000 : [0, 2, 12, 90, 800][count] || 0) + open * 6;
  }
  return total;
}

function bestByScore(board: Board, who: number) {
  let best: { x: number; y: number } | null = null;
  let bestScore = -1;
  for (const [x, y] of emptyPoints(board)) {
    const score = lineScore(board, x, y, who) + lineScore(board, x, y, who === 1 ? 2 : 1) * 0.9;
    if (score > bestScore) {
      bestScore = score;
      best = { x, y };
    }
  }
  return best;
}

function boardText(board: Board) {
  const size = board.length;
  const header = `   ${Array.from({ length: size }, (_, i) => String(i).padStart(2)).join('')}`;
  const rows = board.map(
    (row, y) => `${String(y).padStart(2)} ${row.map((v) => (v === 0 ? '·' : v === 1 ? '●' : '○')).join(' ')}`,
  );
  return [header, ...rows].join('\n');
}

export async function decide({
  character,
  game,
  state,
  userName,
}: {
  character: { name: string; tagline?: string | null; personality?: string | null };
  game: 'rps' | 'gomoku';
  state: any;
  userName: string;
}) {
  let forced: { x: number; y: number } | null = null;
  const board: Board | null = game === 'gomoku' ? (state.board as Board) : null;

  if (board) {
    forced = findWinningPoint(board, 2) || findWinningPoint(board, 1);
  }

  let move: any = null;
  let talk = '';

  const brief =
    game === 'rps'
      ? [
          '你们在玩石头剪刀布，三局两胜。',
          `当前比分：你 ${state.aiWins ?? 0} 胜，对方 ${state.userWins ?? 0} 胜，这是第 ${(state.round ?? 0) + 1} 局。`,
          '同时出手：你想出什么？只返回 JSON：{"move":"rock|scissors|paper","talk":"一句话"}。',
        ].join('\n')
      : [
          '你们在下五子棋（9×9，你执白○，对方执黑●，五连即胜）。',
          '棋盘（·空位，●对方的子，○你的子）：',
          boardText(board as Board),
          state.lastMove ? `对方最近一手：(${state.lastMove.x},${state.lastMove.y})。` : '对方还没落子。',
          forced
            ? `注意：必须下在 (${forced.x},${forced.y})。`
            : '想一个位置落子，必须是空位。',
          '只返回 JSON：{"x":横坐标,"y":纵坐标,"talk":"一句话"}，坐标 0-8。',
        ].join('\n');

  const out = await ask(brief, character, userName);
  const parsed = parseJson(out);
  if (parsed) {
    talk = cleanTalk(parsed.talk);
    if (game === 'rps') {
      const m = String(parsed.move || '').toLowerCase();
      if (MOVES.includes(m)) move = m;
    } else if (board) {
      const x = Number(parsed.x);
      const y = Number(parsed.y);
      if (Number.isInteger(x) && Number.isInteger(y) && inBoard(board, x, y) && board[y][x] === 0) {
        move = { x, y };
      }
    }
  }

  if (game === 'rps') {
    return { move: move || MOVES[Math.floor(Math.random() * 3)], talk, source: move ? 'model' : 'heuristic' };
  }
  if (forced) return { move: forced, talk, source: 'heuristic' };
  if (move) return { move, talk, source: 'model' };
  return { move: bestByScore(board as Board, 2) || emptyPoints(board as Board)[0], talk, source: 'heuristic' };
}

export async function finish({
  character,
  game,
  result,
  note,
  userName,
}: {
  character: { name: string; tagline?: string | null; personality?: string | null };
  game: 'rps' | 'gomoku';
  result: 'win' | 'lose' | 'draw';
  note: string;
  userName: string;
}) {
  const label = GAME_LABEL[game] || '游戏';
  const factual = `和${userName || '对方'}玩了一局${label}${note ? `，${note}` : ''}，结果是${
    result === 'win' ? '对方赢了' : result === 'lose' ? '自己赢了' : '平局'
  }。`;

  const prompt = `你们刚玩完一局${label}，${note}结果：${
    result === 'win' ? '对方赢了' : result === 'lose' ? '你赢了' : '平局'
  }。用一句话说说你现在的心情或想对对方说的话，20 字以内，不要解释、不要加引号。`;

  const line = cleanTalk(await ask(prompt, character, userName));
  return { factual, line: line || `（我们刚玩了一局${label}，${note}）`, at: now() };
}
