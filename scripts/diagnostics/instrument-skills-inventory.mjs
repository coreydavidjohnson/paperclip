import fs from "node:fs";
const file = "server/src/services/company-skills.ts";
let source = fs.readFileSync(file, "utf8");
for (const phase of ["ensureBundledSkills", "ensureBundledSkillReleases", "reconcilePaperclipSkillFolders", "reconcileLocalPathSkillSources"]) {
  const statement = phase === "ensureBundledSkills" ? "const bundledSkills = await ensureBundledSkills(companyId);" : `await ${phase}(companyId${phase === "ensureBundledSkillReleases" ? ", bundledSkills" : ""});`;
  if (!source.includes(statement)) throw new Error("Missing phase " + phase);
  source = source.replace(statement, `const start_${phase} = performance.now(); ${statement} console.info("PER959_PHASE", JSON.stringify({phase:"${phase}",ms:performance.now()-start_${phase}}));`);
}
fs.writeFileSync(file, source);
source = fs.readFileSync(file, "utf8");
const lookup = "const existing = await getByKey(companyId, skill.key, database);";
source = source.replace(lookup, `const lookupStart = performance.now(); ${lookup} console.info("PER959_SUBPHASE", JSON.stringify({phase:"upsertLookup",key:skill.key,ms:performance.now()-lookupStart}));`);
const folder = 'const bundledFolder = bundledCategory\n        ? await folderSvc.ensureBundledCategory(companyId, bundledFolderLabel(bundledCategory))\n        : null;';
if (!source.includes(folder)) throw new Error("Missing upsert folder phase");
source = source.replace(folder, `const folderStart = performance.now(); ${folder} console.info("PER959_SUBPHASE", JSON.stringify({phase:"upsertFolder",key:skill.key,ms:performance.now()-folderStart}));`);
fs.writeFileSync(file, source);
