import { loadAuthConfig } from "../config/index.js";
import { issueDevelopmentAccessToken } from "./token-issuer.js";

const subjectIndex = process.argv.indexOf("--subject");
const subject =
  subjectIndex === -1 ? undefined : process.argv[subjectIndex + 1];
if (
  subject === undefined ||
  !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(subject)
) {
  console.error("Usage: pnpm auth:dev-token -- --subject <safe-subject>");
  process.exitCode = 1;
} else {
  const config = loadAuthConfig();
  const token = await issueDevelopmentAccessToken(config, subject);
  process.stdout.write(`${token}\n`);
}
