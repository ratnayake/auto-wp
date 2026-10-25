import { defineConfig } from 'vitepress';

const repo = 'https://github.com/ratnayake/auto-wp';

export default defineConfig({
  title: 'auto-wp',
  description:
    'Maintain WordPress sites on shared hosting with an AI assistant: verified backups, safe updates, clear reports.',
  base: process.env.DOCS_BASE || '/',
  lang: 'en-US',
  cleanUrls: true,
  lastUpdated: true,
  head: [['meta', { name: 'theme-color', content: '#3451b2' }]],
  themeConfig: {
    siteTitle: 'auto-wp',
    nav: [
      { text: 'Guide', link: '/guide/what-is-auto-wp', activeMatch: '/guide/' },
      { text: 'Deploy', link: '/deploy/docker-vps', activeMatch: '/deploy/' },
      { text: 'Connect sites', link: '/sites/cpanel-no-ssh', activeMatch: '/sites/' },
      { text: 'Daily use', link: '/usage/first-run', activeMatch: '/usage/' },
      { text: 'Reference', link: '/reference/tools', activeMatch: '/reference/' },
      { text: 'Help', link: '/help/troubleshooting', activeMatch: '/help/' },
    ],
    sidebar: [
      {
        text: 'Introduction',
        items: [
          { text: 'What is auto-wp?', link: '/guide/what-is-auto-wp' },
          { text: 'How it works', link: '/guide/how-it-works' },
        ],
      },
      {
        text: 'Getting started',
        items: [
          { text: 'Choose your setup', link: '/guide/choose-setup' },
          { text: 'Quick start (try it locally)', link: '/guide/quick-start' },
          { text: 'Install', link: '/guide/install' },
        ],
      },
      {
        text: 'Deploy the server',
        items: [
          { text: 'Docker on a VPS (recommended)', link: '/deploy/docker-vps' },
          { text: 'Local (stdio)', link: '/deploy/local-stdio' },
          { text: 'systemd on a VPS', link: '/deploy/systemd-vps' },
        ],
      },
      {
        text: 'Connect sites',
        items: [
          { text: 'cPanel without SSH (recommended)', link: '/sites/cpanel-no-ssh' },
          { text: 'cPanel with SSH', link: '/sites/cpanel-ssh' },
          { text: 'Any host with SSH', link: '/sites/ssh-generic' },
          { text: 'Install the agent by hand', link: '/sites/agent-manual' },
          { text: 'Configuration, policy and secrets', link: '/sites/configuration' },
        ],
      },
      {
        text: 'Daily use',
        items: [
          { text: 'Your first maintenance run', link: '/usage/first-run' },
          { text: 'Reports', link: '/usage/reports' },
          { text: 'Restore and housekeeping', link: '/usage/restore' },
          { text: 'Vulnerability data', link: '/usage/vulnerability-data' },
        ],
      },
      {
        text: 'Reference',
        items: [
          { text: 'MCP tools', link: '/reference/tools' },
          { text: 'Environment variables', link: '/reference/environment' },
          { text: 'Config file', link: '/reference/config' },
        ],
      },
      {
        text: 'Help',
        items: [
          { text: 'Troubleshooting', link: '/help/troubleshooting' },
          { text: 'Security checklist', link: '/help/security-checklist' },
          { text: 'FAQ', link: '/help/faq' },
        ],
      },
      {
        text: 'Design',
        items: [
          { text: 'ADR-001: Architecture', link: '/ADR-001-architecture' },
          { text: 'Agent protocol', link: '/agent-protocol' },
        ],
      },
    ],
    socialLinks: [{ icon: 'github', link: repo }],
    search: { provider: 'local' },
    editLink: {
      pattern: `${repo}/edit/main/docs/:path`,
      text: 'Edit this page on GitHub',
    },
    outline: { level: [2, 3], label: 'On this page' },
    lastUpdated: { text: 'Last updated' },
    docFooter: { prev: 'Previous', next: 'Next' },
    footer: {
      message: 'Released under the project license.',
      copyright: 'auto-wp',
    },
  },
});
