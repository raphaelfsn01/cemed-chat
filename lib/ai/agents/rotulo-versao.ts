/**
 * Rótulo da versão do agente na tela: 7 → "0.7", 12 → "1.2".
 *
 * A sequência no banco continua inteira (`ai_agent_versions.version_number` é 1, 2,
 * 3…) — o que muda é só a leitura. Pedido do Raphael: "v7" depois de dois dias de uso
 * dá a impressão de um sistema que salta de versão a cada mexida, quando cada número
 * é uma publicação. Em décimos, a mesma contagem se lê devagar, e o salto de 0.9 para
 * 1.0 fica com o peso que ele merece.
 *
 * Use em TODO lugar que mostra versão de agente (selo, botão de publicar, aviso de
 * salvo, histórico e comparação) — rótulo divergente entre telas é pior que rótulo feio.
 */
export function rotuloVersao(numero: number): string {
  return (numero / 10).toFixed(1);
}
