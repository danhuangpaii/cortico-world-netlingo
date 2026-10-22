/** 包入口:默认导出 `WorldDefinition`,加载器按 `cortico.kind === 'world'` 认它。 */
import { NETLINGO } from './definition.ts';

export default NETLINGO;
export { NETLINGO };
export type { NetlingoConfigSection, NetlingoProactiveSection } from './config.ts';
