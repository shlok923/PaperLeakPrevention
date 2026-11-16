import { createRequire } from "node:module";
import type sodiumType from "libsodium-wrappers";

const require = createRequire(import.meta.url);
const sodium = require("libsodium-wrappers") as typeof sodiumType;

export default sodium;
