/**
 * Idade do número e teto de aquecimento vigente — a MESMA regra do motor
 * (`warmupCapFor`, lib/agent-engine/pacing/engine.ts), para a tela mostrar o que o
 * motor vai fazer. Módulo puro, sem banco: roda no navegador.
 *
 * Sem data de ativação o motor trata o número como novo (idade 0) e aplica o degrau
 * mais baixo — foi assim que o número da CEMED, em uso desde 09/09, ficou limitado a
 * 20 mensagens por dia em 14/11/2026.
 */
import { warmupCapFor } from "@/lib/agent-engine/pacing/engine";
import type { WarmupStep } from "@/lib/agent-engine/pacing/defaults";

const DIA_MS = 86_400_000;

export interface Aquecimento {
  /** dias desde a ativação; null = sem data (o motor usa idade 0). */
  idadeDias: number | null;
  /** teto diário do aquecimento; null = número formado, sem teto de aquecimento. */
  tetoDia: number | null;
}

/** Aceita "AAAA-MM-DD" ou o timestamp do banco; usa só a data (meia-noite UTC, como o banco grava). */
export function aquecimentoAtual(ativadoEm: string | null, degraus: WarmupStep[], agora: Date): Aquecimento {
  if (ativadoEm === null || ativadoEm.length < 10) {
    return { idadeDias: null, tetoDia: warmupCapFor(0, degraus) };
  }
  const inicio = Date.parse(`${ativadoEm.slice(0, 10)}T00:00:00Z`);
  // Data ilegível (navegador sem seletor de data, texto livre): trata como sem data.
  if (Number.isNaN(inicio)) return { idadeDias: null, tetoDia: warmupCapFor(0, degraus) };
  const idadeDias = Math.max(0, Math.floor((agora.getTime() - inicio) / DIA_MS));
  return { idadeDias, tetoDia: warmupCapFor(idadeDias, degraus) };
}
