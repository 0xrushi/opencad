import type { CadOp } from './chatAi.ts';

type OpsCarrier = { ops?: CadOp[]; cuts?: Extract<CadOp, { type: 'cut' }>[] };

/** The artifact's operation history, including older cut-only artifacts. */
export function artifactOps(data: OpsCarrier | null | undefined): CadOp[] {
  if (!data) return [];
  if (data.ops) return data.ops;
  return (data.cuts ?? []).map((cut) => ({ ...cut, type: 'cut' as const }));
}
