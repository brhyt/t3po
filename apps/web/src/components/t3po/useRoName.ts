import * as Schema from "effect/Schema";
import { useLocalStorage } from "../../hooks/useLocalStorage";
const nameSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(80));
export function useRoName() {
  return useLocalStorage("t3po.ro-name", "Ro", nameSchema);
}
