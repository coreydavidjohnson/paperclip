import fs from "node:fs";
const file = "server/src/services/company-skills.ts";
let source = fs.readFileSync(file, "utf8");
for (const phase of ["ensureBundledSkills", "ensureBundledSkillReleases", "reconcilePaperclipSkillFolders", "reconcileLocalPathSkillSources"]) {
  const statement = phase === "ensureBundledSkills" ? "const bundledSkills = await ensureBundledSkills(companyId);" : `await ${phase}(companyId${phase === "ensureBundledSkillReleases" ? ", bundledSkills" : ""});`;
  if (!source.includes(statement)) throw new Error("Missing phase " + phase);
  source = source.replace(statement, `const start_${phase} = performance.now(); ${statement} console.info("PER959_PHASE", JSON.stringify({phase:"${phase}",ms:performance.now()-start_${phase}}));`);
}
fs.writeFileSync(file, source);
