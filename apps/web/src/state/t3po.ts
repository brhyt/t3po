import { createT3poAtoms } from "@t3tools/client-runtime/state/t3po";
import { connectionAtomRuntime } from "../connection/runtime";
export const t3po = createT3poAtoms(connectionAtomRuntime);
