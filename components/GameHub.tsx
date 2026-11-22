'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { useApp } from '@/lib/store';
import type { Character, Message } from '@/lib/types';
import { Modal, Spinner } from './ui';

type Move = 'rock' | 'scissors' | 'paper';
type Outcome = 'win' | 'lose' | 'draw';
type GameKey = 'rps' | 'gomoku';

const MOVES: { key: Move; emoji: string; label: string }[] = [
  { key: 'rock', emoji: '✊', label: '石头' },
  { key: 'scissors', emoji: '✌️', label: '剪刀' },
  { key: 'paper', emoji: '✋', label: '布' },
];

const BEATS: Record<Move, Move> = { rock: 'scissors', scissors: 'paper', paper: 'rock' };
const SIZE = 9;
const EMPTY = () => Array.from({ length: SIZE }, () => Array<number>(SIZE).fill(0));

function stone(v: number) {
  if (v === 1) return <span className="block h-full w-full rounded-full bg-[#2f3239] shadow-inner" />;
  if (v === 2) return <span className="block h-full w-full rounded-full border border-line bg-[#f3f1ec]" />;
  return null;
}

function winLine(board: number[][], x: number, y: number, who: number) {
  const dirs = [
    [1, 0],
    [0, 1],
    [1, 1],
    [1, -1],
  ];
  for (const [dx, dy] of dirs) {
    let count = 1;
    for (const sign of [1, -1]) {
      for (let i = 1; i < 5; i++) {
        const nx = x + dx * i * sign;
        const ny = y + dy * i * sign;
        if (nx < 0 || ny < 0 || nx >= SIZE || ny >= SIZE || board[ny][nx] !== who) break;
        count += 1;
      }
    }
    if (count >= 5) return true;
  }
  return false;
}

/**
 * 小游戏中心：先选游戏，再进具体玩法。
 * 每一步都由当前聊天模型以角色身份决定，规则兜底防走瞎棋；
 * 一局结束会让模型写总结并归档进记忆。
 */
export default function GameHub({
  open,
  character,
  onClose,
}: {
  open: boolean;
  character: Character | null;
  onClose: () => void;
}) {
  const { pushMessage, registerBack } = useApp();
  const [step, setStep] = useState<'pick' | GameKey>('pick');

  useEffect(() => {
    if (open) setStep('pick');
  }, [open]);

  // 进了某个游戏时，返回先回到选游戏，而不是直接关掉整个小游戏
  useEffect(() => {
    if (!open || step === 'pick') return;
    return registerBack('game-detail', () => setStep('pick'));
  }, [open, step, registerBack]);

  if (!character) return null;

  const title =
    step === 'pick'
      ? `和${character.name}玩点什么`
      : step === 'rps'
        ? `✊ 石头剪刀布`
        : '⚫ 五子棋';

  const subtitle =
    step === 'pick'
      ? '她会用自己的性格陪你玩，玩完还会记进记忆'
      : step === 'rps'
        ? '三局两胜 · 她会按自己的性子出拳'
        : '9×9 · 你执黑先手，她执白';

  return (
    <Modal open={open} onClose={onClose} title={title} subtitle={subtitle} width="max-w-[440px]">
      {step !== 'pick' ? (
        <button
          onClick={() => setStep('pick')}
          className="mb-3 flex items-center gap-1 text-[11.5px] text-fg-dim transition hover:text-fg"
        >
          ‹ 换个游戏
        </button>
      ) : null}

      {step === 'pick' ? (
        <div className="space-y-2.5">
          <button
            onClick={() => setStep('rps')}
            className="flex w-full items-center gap-3 rounded-2xl border border-line bg-tint/[0.02] px-3.5 py-3.5 text-left transition hover:border-brand/40"
          >
            <span className="text-[26px]">✊</span>
            <span className="min-w-0 flex-1">
              <span className="block text-[14px] font-medium text-fg">石头剪刀布</span>
              <span className="mt-0.5 block text-[11px] text-fg-dimmer">三局两胜，快，适合边聊边玩</span>
            </span>
            <span className="text-fg-dimmer">›</span>
          </button>

          <button
            onClick={() => setStep('gomoku')}
            className="flex w-full items-center gap-3 rounded-2xl border border-line bg-tint/[0.02] px-3.5 py-3.5 text-left transition hover:border-brand/40"
          >
            <span className="text-[26px]">⚫</span>
            <span className="min-w-0 flex-1">
              <span className="block text-[14px] font-medium text-fg">五子棋</span>
              <span className="mt-0.5 block text-[11px] text-fg-dimmer">9×9 快棋，连成五子就赢</span>
            </span>
            <span className="text-fg-dimmer">›</span>
          </button>

          <p className="pt-1 text-[10.5px] leading-relaxed text-fg-dimmer">
            每一手都是她按自己的性格想的，不是随机数。玩完会总结一句，记进你们的记忆里。
          </p>
        </div>
      ) : step === 'rps' ? (
        <RpsGame character={character} onFinishLine={pushMessage} />
      ) : (
        <GomokuGame character={character} onFinishLine={pushMessage} />
      )}
    </Modal>
  );
}

// ---------------- 石头剪刀布 ----------------
function RpsGame({
  character,
  onFinishLine,
}: {
  character: Character;
  onFinishLine: (msg: Message) => void;
}) {
  const [round, setRound] = useState(0);
  const [userWins, setUserWins] = useState(0);
  const [aiWins, setAiWins] = useState(0);
  const [history, setHistory] = useState<Array<{ user: Move; ai: Move; outcome: Outcome }>>([]);
  const [last, setLast] = useState<{ user: Move; ai: Move; outcome: Outcome } | null>(null);
  const [final, setFinal] = useState<Outcome | null>(null);
  const [busy, setBusy] = useState(false);
  const [talk, setTalk] = useState('');
  const recorded = useRef(false);

  const emojiOf = (m: Move) => MOVES.find((x) => x.key === m)?.emoji ?? '';

  const finish = useCallback(
    async (result: Outcome, note: string) => {
      if (recorded.current) return;
      recorded.current = true;
      setFinal(result);
      try {
        const r = await api<{ line: string; message: Message; marker?: Message }>('/api/game/finish', {
          method: 'POST',
          body: { characterId: character.id, game: 'rps', result, note },
        });
        if (r.line) setTalk(r.line);
        // 先落结果提示条，再落她说的那句话
        if (r.marker) onFinishLine(r.marker);
        if (r.message) onFinishLine(r.message);
      } catch {
        /* 记录失败不影响继续玩 */
      }
    },
    [character.id, onFinishLine],
  );

  async function play(move: Move) {
    if (busy || final) return;
    setBusy(true);
    let ai: Move = MOVES[Math.floor(Math.random() * 3)].key;
    try {
      const r = await api<{ move: string; talk: string }>('/api/game/move', {
        method: 'POST',
        body: {
          characterId: character.id,
          game: 'rps',
          state: { round, userWins, aiWins, history: history.slice(-4) },
        },
      });
      if (MOVES.some((m) => m.key === r.move)) ai = r.move as Move;
      if (r.talk) setTalk(r.talk);
    } catch {
      /* 模型不可用就随机，能玩下去 */
    }

    const outcome: Outcome = move === ai ? 'draw' : BEATS[move] === ai ? 'win' : 'lose';
    const nextUser = userWins + (outcome === 'win' ? 1 : 0);
    const nextAi = aiWins + (outcome === 'lose' ? 1 : 0);
    const nextRound = round + 1;

    setLast({ user: move, ai, outcome });
    setHistory((h) => [...h, { user: move, ai, outcome }]);
    setUserWins(nextUser);
    setAiWins(nextAi);
    setRound(nextRound);
    setBusy(false);

    if (nextUser >= 2 || nextAi >= 2 || nextRound >= 3) {
      const result: Outcome = nextUser > nextAi ? 'win' : nextUser < nextAi ? 'lose' : 'draw';
      const note = `我（对方）${nextUser} : ${nextAi} 你（${character.name}），${nextRound} 局`;
      setTimeout(() => void finish(result, note), 420);
    }
  }

  return (
    <div>
      <div className="flex items-center justify-center gap-6 pb-2">
        <div className="text-center">
          <p className="text-[26px] font-bold text-fg">{userWins}</p>
          <p className="text-[11px] text-fg-dimmer">你</p>
        </div>
        <span className="text-[13px] text-fg-dimmer">:</span>
        <div className="text-center">
          <p className="text-[26px] font-bold text-fg">{aiWins}</p>
          <p className="text-[11px] text-fg-dimmer">{character.name}</p>
        </div>
      </div>

      <div className="mt-2 flex items-center justify-center gap-3">
        {MOVES.map((m) => (
          <button
            key={m.key}
            onClick={() => void play(m.key)}
            disabled={!!final || busy}
            className="flex h-[74px] w-[74px] flex-col items-center justify-center gap-1 rounded-2xl border border-line bg-raise/60 transition hover:-translate-y-0.5 hover:border-brand/50 disabled:opacity-40"
          >
            <span className="text-[26px]">{m.emoji}</span>
            <span className="text-[10.5px] text-fg-dimmer">{m.label}</span>
          </button>
        ))}
      </div>

      <div className="mt-4 min-h-[64px] rounded-xl border border-line bg-tint/[0.02] px-3 py-2.5 text-center">
        {busy ? (
          <span className="inline-flex items-center gap-2 py-1 text-[12.5px] text-fg-dim">
            <Spinner size={13} /> 她在想…
          </span>
        ) : final ? (
          <p className="text-[13.5px] leading-relaxed">
            {final === 'win' ? (
              <span className="font-semibold text-ok">你赢了</span>
            ) : final === 'lose' ? (
              <span className="font-semibold text-brand-soft">{character.name}赢了</span>
            ) : (
              <span className="font-semibold text-warn">打平了</span>
            )}
            <br />
            <span className="text-[11.5px] text-fg-dimmer">{talk || '已记进你们的记忆'}</span>
          </p>
        ) : last ? (
          <p className="text-[13px] leading-relaxed text-fg">
            你出 {emojiOf(last.user)} · {character.name}出 {emojiOf(last.ai)} →{' '}
            {last.outcome === 'win' ? (
              <span className="font-semibold text-ok">你赢</span>
            ) : last.outcome === 'lose' ? (
              <span className="font-semibold text-danger">她赢</span>
            ) : (
              <span className="font-semibold text-warn">平局</span>
            )}
            <br />
            <span className="text-[11.5px] text-fg-dimmer">{talk || `第 ${round} 局`}</span>
          </p>
        ) : (
          <p className="py-1 text-[13px] text-fg-dim">选一个吧，{character.name}在等你</p>
        )}
      </div>

      <div className="mt-4 flex gap-2">
        {final ? (
          <button
            onClick={() => {
              setRound(0);
              setUserWins(0);
              setAiWins(0);
              setHistory([]);
              setLast(null);
              setFinal(null);
              setTalk('');
              recorded.current = false;
            }}
            className="btn-primary flex-1"
          >
            再来一局
          </button>
        ) : (
          <p className="flex-1 py-2 text-center text-[11px] text-fg-dimmer">
            第 {round + 1} 局 · 先赢两局者胜
          </p>
        )}
      </div>
    </div>
  );
}

// ---------------- 五子棋 ----------------
function GomokuGame({
  character,
  onFinishLine,
}: {
  character: Character;
  onFinishLine: (msg: Message) => void;
}) {
  const [board, setBoard] = useState<number[][]>(EMPTY);
  const [over, setOver] = useState<Outcome | null>(null);
  const [busy, setBusy] = useState(false);
  const [talk, setTalk] = useState('');
  const [moves, setMoves] = useState(0);
  const recorded = useRef(false);

  const emptyCount = useMemo(() => board.flat().filter((v) => v === 0).length, [board]);

  const finish = useCallback(
    async (result: Outcome, note: string) => {
      if (recorded.current) return;
      recorded.current = true;
      setOver(result);
      try {
        const r = await api<{ line: string; message: Message; marker?: Message }>('/api/game/finish', {
          method: 'POST',
          body: { characterId: character.id, game: 'gomoku', result, note },
        });
        if (r.line) setTalk(r.line);
        if (r.marker) onFinishLine(r.marker);
        if (r.message) onFinishLine(r.message);
      } catch {
        /* ignore */
      }
    },
    [character.id, onFinishLine],
  );

  async function place(x: number, y: number) {
    if (busy || over || board[y][x] !== 0) return;

    const next = board.map((row) => row.slice());
    next[y][x] = 1;
    setBoard(next);
    setMoves((m) => m + 1);

    if (winLine(next, x, y, 1)) {
      void finish('win', `下到第 ${moves + 1} 手，对方连成五子`);
      return;
    }
    if (next.flat().every((v) => v !== 0)) {
      void finish('draw', '棋盘下满了，平局');
      return;
    }

    setBusy(true);
    try {
      const r = await api<{ move: { x: number; y: number } | null; talk: string }>('/api/game/move', {
        method: 'POST',
        body: { characterId: character.id, game: 'gomoku', state: { board: next, lastMove: { x, y } } },
      });
      if (r.talk) setTalk(r.talk);
      const mv = r.move;
      if (!mv || next[mv.y]?.[mv.x] !== 0) {
        setBusy(false);
        return;
      }
      const after = next.map((row) => row.slice());
      after[mv.y][mv.x] = 2;
      setBoard(after);
      setMoves((m) => m + 1);
      if (winLine(after, mv.x, mv.y, 2)) {
        void finish('lose', `下到第 ${moves + 2} 手，${character.name}连成五子`);
      } else if (after.flat().every((v) => v !== 0)) {
        void finish('draw', '棋盘下满了，平局');
      }
    } catch {
      setTalk('（她愣了一下，这手没下出来）');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="mx-auto w-full max-w-[360px]">
        <div className="overflow-hidden rounded-xl border border-line bg-[#e8dcc6] p-1.5">
          <div className="grid grid-cols-9 gap-0">
            {board.map((row, y) =>
              row.map((v, x) => (
                <button
                  key={`${x}-${y}`}
                  onClick={() => void place(x, y)}
                  disabled={busy || !!over || v !== 0}
                  className="flex aspect-square items-center justify-center border border-[#c9b89a]/40 p-[3px] transition disabled:cursor-default"
                  aria-label={`第${y + 1}行第${x + 1}列`}
                >
                  {stone(v)}
                </button>
              )),
            )}
          </div>
        </div>
      </div>

      <div className="mt-3 min-h-[46px] rounded-xl border border-line bg-tint/[0.02] px-3 py-2 text-center">
        {over ? (
          <p className="text-[13px] leading-relaxed">
            {over === 'win' ? (
              <span className="font-semibold text-ok">你赢了</span>
            ) : over === 'lose' ? (
              <span className="font-semibold text-brand-soft">{character.name}赢了</span>
            ) : (
              <span className="font-semibold text-warn">平局</span>
            )}
            <br />
            <span className="text-[11.5px] text-fg-dimmer">{talk || '已记进你们的记忆'}</span>
          </p>
        ) : busy ? (
          <span className="inline-flex items-center gap-2 py-0.5 text-[12.5px] text-fg-dim">
            <Spinner size={13} /> {character.name}在想下哪儿…
          </span>
        ) : talk ? (
          <p className="text-[12.5px] leading-relaxed text-fg-dim">{talk}</p>
        ) : (
          <p className="py-0.5 text-[12px] text-fg-dimmer">
            你执黑先手 · 还剩 {emptyCount} 个空位
          </p>
        )}
      </div>

      <div className="mt-3 flex gap-2">
        {over ? (
          <button
            onClick={() => {
              setBoard(EMPTY());
              setOver(null);
              setTalk('');
              setMoves(0);
              recorded.current = false;
            }}
            className="btn-primary flex-1"
          >
            再来一局
          </button>
        ) : (
          <p className="flex-1 py-1.5 text-center text-[11px] text-fg-dimmer">
            点棋盘落子 · 她每手都会想一下
          </p>
        )}
      </div>
    </div>
  );
}
