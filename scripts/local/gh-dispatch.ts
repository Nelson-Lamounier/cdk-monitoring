import { execSync, spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';

function runCmd(command: string, inheritIo = false): string {
    if (inheritIo) {
        spawnSync(command, { stdio: 'inherit', shell: true });
        return '';
    }
    return execSync(command, { encoding: 'utf-8' }).trim();
}

function main() {
    const { positionals }: { positionals: string[] } = parseArgs({
        args: process.argv.slice(2),
        allowPositionals: true,
    });

    if (positionals.length === 0) {
        console.error('❌ Error: Please provide a workflow file name (e.g., deploy-frontend.yml)');
        process.exit(1);
    }

    const workflow = positionals[0];
    const branch = runCmd('git rev-parse --abbrev-ref HEAD');

    console.log('══════════════════════════════════════════════════════════════');
    console.log('  Automated GitHub Workflow Dispatch');
    console.log(`  Workflow: ${workflow}`);
    console.log(`  Branch:   ${branch}`);
    console.log('══════════════════════════════════════════════════════════════\n');

    // 1. Stage github directory
    try {
        runCmd('git add .github/');
    } catch (error) {
        console.error('❌ Failed to stage .github/ changes', error);
        process.exit(1);
    }

    // 2. Commit and push if there are changes
    try {
        // git diff --cached --quiet returns 0 if NO changes, 1 if changes exist
        runCmd('git diff --cached --quiet');
        console.log('ℹ️  No uncommitted changes in .github/ to commit.');
    } catch {
        console.log('📦 Committing changes...');
        runCmd('git commit -m "chore(ci): update workflow for local test"');

        console.log(`🚀 Pushing to origin/${branch}...`);
        runCmd(`git push origin "${branch}"`);
    }

    // 3. Dispatch workflow
    console.log(`\n⏳ Dispatching workflow ${workflow} on branch ${branch}...`);
    try {
        runCmd(`gh workflow run "${workflow}" --ref "${branch}"`);
    } catch (error) {
        console.error(`❌ Failed to dispatch workflow: ${workflow}`, error);
        process.exit(1);
    }

    // 4. Wait a moment for GitHub to register the run
    console.log('Waiting 4 seconds for workflow to become visible...');
    runCmd('sleep 4');

    // 5. Watch workflow run
    console.log('👀 Watching workflow...');
    try {
        // Interactive shell for gh run watch
        runCmd('gh run watch', true);
    } catch (error) {
        console.log(`\n✅ Workflow dispatched. (Could not auto-watch run: ${String(error)})`);
    }
}

main();
