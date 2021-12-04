import * as core from '@actions/core';
import * as github from '@actions/github';
import { GitHub } from '@actions/github/lib/utils';
import type { PullRequest, PullRequestEvent } from '@octokit/webhooks-definitions/schema';

class State {
  owner: string;
  repo: string;
  mainline_ref: string;
  seen: Set<string>;
  repo_id: string;
  found: Set<string>;
  pending: Array<string>;
  visited: Set<string>;

  constructor(event: PullRequestEvent) {
    this.owner = github.context.repo.owner;
    this.repo = github.context.repo.repo;

    const repo = event.pull_request.base.repo;
    if (repo.owner.login != this.owner || repo.name != this.repo) {
      throw new Error(`this pull request seems to be targeting a different repository`);
    }

    this.repo_id = repo.node_id;
    this.mainline_ref = event.pull_request.base.repo.default_branch;
    this.seen = new Set();
    this.found = new Set();
    this.pending = new Array();
    this.visited = new Set();
  }

  push_pull_request(pr: PullRequest) {
    if (this.seen.has(pr.node_id)) {
      return;
    } else {
      this.seen.add(pr.node_id);
    }

    if (pr.base.repo.node_id !== this.repo_id) {
      core.warning(`pull request ${pr.issue_url} seems to be targeting a different repository`);
      return;
    }

    if (pr.base.repo.default_branch != this.mainline_ref) {
      throw new Error("default_branch is inconsistent across pull requests");
    }

    if (pr.base.ref == this.mainline_ref) {
      this.found.add(pr.base.sha);
    } else {
      this.pending.push(pr.base.sha);
    }
  }

  async find_more(gh: InstanceType<typeof GitHub>): Promise<boolean> {
    let commit_sha = this.pending.pop();
    if (!commit_sha) {
      return false;
    }

    if (this.visited.has(commit_sha)) {
      return true;
    } else {
      this.visited.add(commit_sha);
    }

    const res = await gh.rest.repos.listPullRequestsAssociatedWithCommit({
      commit_sha,
      owner: this.owner,
      repo: this.repo,
    });

    for (const pr of res.data) {
      this.push_pull_request(pr as PullRequest);
    }

    return true;
  }
}

async function run(): Promise<void> {
  try {
    const token = core.getInput('github_token');
    const octokit = github.getOctokit(token);

    if (github.context.eventName !== 'pull_request') {
      throw new Error("can only run for pull_request events");
    }

    const event = github.context.payload as PullRequestEvent;
    const state = new State(event);

    state.push_pull_request(event.pull_request);

    while (await state.find_more(octokit)) { }

    if (state.found.size === 0) {
      throw new Error("no mainline base reference was found");
    }
    if (state.found.size > 1) {
      throw new Error("multiple mainline base reference candidates were found");
    }

    for (const commit_sha of state.found) {
      core.exportVariable("MAINLINE_BASE_SHA", commit_sha);
      core.exportVariable("MAINLINE_BASE_REF", state.mainline_ref);
    }

  } catch (error) {
    if (error instanceof Error) core.setFailed(error.message)
  }
}

run()
