/**
 * 浏览器自带的语音能力封装。
 *
 * 为什么先用浏览器原生：
 * - 语音识别（STT）零配置、零费用，不需要用户先去配供应商；
 * - 朗读（TTS）用系统语音，中文可用。
 *
 * 已知限制（必须在 UI 上诚实提示）：
 * - SpeechRecognition 需要**安全上下文**（localhost 或 HTTPS）。局域网 http://192.168.x 下不可用。
 * - 部分浏览器（Firefox）没有该 API；Safari 需要用户手势触发。
 */

type SpeechResultLike = {
  resultIndex: number;
  results: {
    length: number;
    [i: number]: { isFinal: boolean; 0: { transcript: string } };
  };
};

type Recognizer = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((e: SpeechResultLike) => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
  onend: (() => void) | null;
};

type RecognizerCtor = new () => Recognizer;

function ctor(): RecognizerCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    SpeechRecognition?: RecognizerCtor;
    webkitSpeechRecognition?: RecognizerCtor;
  };
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

/** 当前环境能不能录音识别 */
export function sttSupported(): boolean {
  if (typeof window === 'undefined') return false;
  // 非安全上下文下浏览器会直接拒绝，提前判断比让用户点了报错好
  const secure = window.isSecureContext || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  return Boolean(ctor()) && secure;
}

export function createRecognizer(lang = 'zh-CN'): Recognizer | null {
  const C = ctor();
  if (!C) return null;
  const r = new C();
  r.lang = lang;
  r.continuous = false;
  r.interimResults = true;
  return r;
}

/** 朗读一段文字；不支持时静默返回 false */
export function speak(text: string, lang = 'zh-CN'): boolean {
  if (typeof window === 'undefined' || !window.speechSynthesis) return false;
  const synth = window.speechSynthesis;
  synth.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = lang;
  u.rate = 1.02;
  u.pitch = 1.05;
  const voice = synth.getVoices().find((v) => v.lang?.toLowerCase().startsWith('zh'));
  if (voice) u.voice = voice;
  synth.speak(u);
  return true;
}

export function stopSpeaking(): void {
  if (typeof window !== 'undefined' && window.speechSynthesis) window.speechSynthesis.cancel();
}
