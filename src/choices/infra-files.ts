// Files for the owner's own infrastructure («Свой путь», STAGE_WORK_MODEL §68): automatic deploy to their server from their
// git service, a Render Blueprint and a container image. Generated deterministically; nothing here holds a secret — the server
// address and SSH key live in the repository's own secret settings, never in BuildPath.
import { tr } from '../i18n/i18n.js';
import type { ApiGitProviderKey, GitFile } from './git-providers.js';

/** Present in every pipeline file BuildPath writes; a file without it belongs to the owner and is never overwritten. */
export const CI_MARKER = 'buildpath-deploy';
export const DEFAULT_DEPLOY_PATH = '/opt/buildpath-site/site';
export const CI_SECRETS = ['SSH_HOST', 'SSH_USER', 'SSH_PRIVATE_KEY', 'SSH_KNOWN_HOSTS'] as const;

export const ciFilePath: Record<ApiGitProviderKey, string> = {
  github: '.github/workflows/buildpath-deploy.yml',
  gitlab: '.gitlab-ci.yml',
  gitea: '.gitea/workflows/buildpath-deploy.yml',
  bitbucket: 'bitbucket-pipelines.yml',
};

export const DEFAULT_BOOKING_PATH = '/opt/buildpath-site';
/** Folder in the repository with the booking program for the owner's server (the same files as app/ in the server package). */
export const BOOKING_APP_DIR = 'server/app';

/**
 * Same steps everywhere: write the key and the pinned host key, then copy to the server. A plain site sends only its pages
 * (*.html); a site with online booking sends the booking program and restarts it — the data folder with bookings is never touched.
 */
function deployScript(indent: string, installTools: boolean, kind: 'static' | 'booking'): string {
  const ssh = 'ssh -i $HOME/.ssh/buildpath_deploy -p ${SSH_PORT:-22} -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$HOME/.ssh/known_hosts';
  const copy = kind === 'static'
    ? [`rsync -rtz --prune-empty-dirs --include='*/' --include='*.html' --exclude='*' -e "${ssh}" ./ "$SSH_USER@$SSH_HOST:\${DEPLOY_PATH:-${DEFAULT_DEPLOY_PATH}}/"`]
    : [
      `rsync -rtz -e "${ssh}" ${BOOKING_APP_DIR}/ "$SSH_USER@$SSH_HOST:\${DEPLOY_PATH:-${DEFAULT_BOOKING_PATH}}/app/"`,
      `${ssh} "$SSH_USER@$SSH_HOST" "cd '\${DEPLOY_PATH:-${DEFAULT_BOOKING_PATH}}' && docker compose restart app"`,
    ];
  const lines = [
    'set -eu',
    ...(installTools ? ['apk add --no-cache openssh-client rsync'] : []),
    'mkdir -p ~/.ssh && chmod 700 ~/.ssh',
    'printf \'%s\\n\' "$SSH_PRIVATE_KEY" > ~/.ssh/buildpath_deploy && chmod 600 ~/.ssh/buildpath_deploy',
    'printf \'%s\\n\' "$SSH_KNOWN_HOSTS" > ~/.ssh/known_hosts',
    ...copy,
  ];
  return lines.map((line) => `${indent}${line}`).join('\n');
}

const header = (kind: 'static' | 'booking') => [
  `# ${CI_MARKER}: ${kind === 'static' ? tr('создано BuildPath. Копирует страницы сайта на ваш сервер после каждой отправки в эту ветку.') : tr('создано BuildPath. Обновляет программу записи на вашем сервере после каждой отправки в эту ветку; записи не трогает.')}`,
  `# ${tr('Нужные секреты репозитория: SSH_HOST, SSH_USER, SSH_PRIVATE_KEY, SSH_KNOWN_HOSTS; необязательно DEPLOY_PATH (по умолчанию {0}) и SSH_PORT (по умолчанию 22).', [kind === 'static' ? DEFAULT_DEPLOY_PATH : DEFAULT_BOOKING_PATH])}`,
];

export function ciDeployFile(provider: ApiGitProviderKey, branch: string, kind: 'static' | 'booking' = 'static'): GitFile {
  const safeBranch = /^[A-Za-z0-9._/-]{1,100}$/.test(branch) ? branch : 'main';
  let body: string[];
  if (provider === 'github' || provider === 'gitea') {
    body = [
      'name: Deploy to own server', 'on:', '  push:', `    branches: [${JSON.stringify(safeBranch)}]`, '  workflow_dispatch: {}',
      'jobs:', '  deploy:', '    runs-on: ubuntu-latest', '    steps:',
      ...(provider === 'github' ? ['      - uses: actions/checkout@v4'] : ['      - uses: https://code.forgejo.org/actions/checkout@v4']),
      '      - name: Copy the site to the server', '        env:',
      ...CI_SECRETS.map((name) => `          ${name}: \${{ secrets.${name} }}`),
      '          DEPLOY_PATH: ${{ secrets.DEPLOY_PATH }}',
      '          SSH_PORT: ${{ secrets.SSH_PORT }}',
      '        run: |',
      ...(provider === 'gitea' ? ['          command -v rsync >/dev/null || (apt-get update && apt-get install -y rsync openssh-client)'] : []),
      deployScript('          ', false, kind),
    ];
  } else if (provider === 'gitlab') {
    body = [
      `${CI_MARKER}:`, '  image: alpine:3.20', '  rules:', `    - if: '$CI_COMMIT_BRANCH == ${JSON.stringify(safeBranch)} && $SSH_HOST'`, '  script:',
      ...deployScript('', true, kind).split('\n').map((line) => `    - ${JSON.stringify(line)}`),
    ];
  } else {
    body = [
      'pipelines:', '  branches:', `    ${JSON.stringify(safeBranch)}:`, '      - step:', `          name: ${CI_MARKER}`, '          image: alpine:3.20', '          script:',
      ...deployScript('', true, kind).split('\n').map((line) => `            - ${JSON.stringify(line)}`),
    ];
  }
  return { path: ciFilePath[provider], content: [...header(kind), ...body, ''].join('\n'), marker: CI_MARKER };
}

/** Render Blueprint: a free static site from the repository; only the pages are published, not project.md or project.json. */
export function renderBlueprint(name: string): GitFile {
  const slug = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'site';
  return {
    path: 'render.yaml',
    content: [
      `# buildpath-render: ${tr('создано BuildPath. В Render нажмите New → Blueprint и выберите этот репозиторий.')}`,
      'services:', '  - type: web', `    name: ${slug}`, '    runtime: static',
      `    buildCommand: "mkdir -p public && find . -name '*.html' -not -path './public/*' -not -path './.git/*' -exec cp --parents {} public/ \\\\;"`,
      '    staticPublishPath: ./public', '    headers:', '      - path: /*', '        name: X-Content-Type-Options', '        value: nosniff', '',
    ].join('\n'),
    marker: 'buildpath-render',
  };
}

/** Container image of the static site: Caddy serving the pages on port 80, for any service that runs Docker images. */
export function staticDockerfile(): string {
  return [
    `# ${tr('Образ сайта для любого сервиса, который запускает Docker-контейнеры: docker build -t my-site . && docker run -p 8080:80 my-site')}`,
    'FROM caddy:2-alpine', 'COPY site /srv', 'EXPOSE 80', 'CMD ["caddy", "file-server", "--root", "/srv", "--listen", ":80"]', '',
  ].join('\n');
}
