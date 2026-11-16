'use client';

import { useEffect, useRef, useState } from 'react';
import { useApp } from '@/lib/store';
import type { Character } from '@/lib/types';
import { Modal } from './ui';

type Move = 'rock' | 'scissors' | 'paper';
type Outcome = 'win' | 'lose' | 'draw';

const MOVES: { key: Move; emoji: string; label: string }[] = [
  { key: 'rock', emoji: '✊', label: '石头' },
  { key: 'scissors', emoji: '✌️', label: '剪刀' },
  { key: 'paper', emoji: '✋', label: '布' },
];

const BEATS: Record<Move, Move> = { rock: 'scissors', scissors: 'paper', paper: 'rock' };

export default function RpsGame({
  open,
  character,
  onClose,
}: {
  open: boolean;
  character: Character | null;
  onClose: () => void;
}) {
  const { recordGame } = useApp();
  const [round, setRound] = useState(0);
  const [userWins, setUserWins] = useState(0);
  const [aiWins, setAiWins] = useState(0);
  const [last, setLast] = useState<{ user: Move; ai: Move; outcome: Outcome } | null>(null);
  const [final, setFinal] = useState<Outcome | null>(null);
  const recorded = useRef(false);

  useEffect(() => {
    if (!open) return;
    setRound(0);
    setUserWins(0);
    setAiWins(0);
    setLast(null);
    setFinal(null);
    recorded.current = false;
  }, [open]);

  useEffect(() => {
    if (!final || !character || recorded.current) return;
    recorded.current = true;
    const score = `我 ${userWins} : ${aiWins} ${final === 'win' ? '赢了' : final === 'lose' ? '输了' : '打平了'}`;
    void recordGame(character.id, final, score);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [final]);

  if (!character) return null;

  function play(move: Move) {
    if (final) return;
    const ai = MOVES[Math.floor(Math.random() * 3)].key;
    const outcome: Outcome = move === ai ? 'draw' : BEATS[move] === ai ? 'win' : 'lose';
    const nextUser = userWins + (outcome === 'win' ? 1 : 0);
    const nextAi = aiWins + (outcome === 'lose' ? 1 : 0);
    const nextRound = round + 1;

    setLast({ user: move, ai, outcome });
    setUserWins(nextUser);
    setAiWins(nextAi);
    setRound(nextRound);

    if (nextUser >= 2 || nextAi >= 2 || nextRound >= 3) {
      const result: Outcome = nextUser > nextAi ? 'win' : nextUser < nextAi ? 'lose' : 'draw';
      setTimeout(() => setFinal(result), 320);
    }
  }

  const emojiOf = (m: Move) => MOVES.find((x) => x.key === m)?.emoji ?? '';

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`🎮 和${character.name}玩石头剪刀布`}
      subtitle="三局两胜 · 玩过的局会记进你们的共同经历"
      width="max-w-sm"
    >
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
            onClick={() => play(m.key)}
            disabled={!!final}
            className="flex h-[74px] w-[74px] flex-col items-center justify-center gap-1 rounded-2xl border border-line bg-raise/60 transition hover:-translate-y-0.5 hover:border-brand/50 disabled:opacity-40"
          >
            <span className="text-[26px]">{m.emoji}</span>
            <span className="text-[10.5px] text-fg-dimmer">{m.label}</span>
          </button>
        ))}
      </div>

      <div className="mt-4 min-h-[54px] rounded-xl border border-line bg-tint/[0.02] px-3 py-2.5 text-center">
        {final ? (
          <p className="text-[13.5px] leading-relaxed">
            {final === 'win' ? (
              <span className="font-semibold text-ok">你赢了！{character.name}欠你一个故事</span>
            ) : final === 'lose' ? (
              <span className="font-semibold text-brand-soft">
                {character.name}赢了，明天记得讲故事给她听
              </span>
            ) : (
              <span className="font-semibold text-warn">打平了，下次再分胜负</span>
            )}
            <br />
            <span className="text-[11.5px] text-fg-dimmer">
              已记入共同经历 · 共 {round} 局
            </span>
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
            <span className="text-[11.5px] text-fg-dimmer">第 {round} 局</span>
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
              setLast(null);
              setFinal(null);
              recorded.current = false;
            }}
            className="btn-primary flex-1"
          >
            再来一局
          </button>
        ) : null}
        <button onClick={onClose} className="btn-ghost flex-1">
          结束游戏
        </button>
      </div>
    </Modal>
  );
}
