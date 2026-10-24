This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
## CosmicForge Admin environment deployment

This monorepo has **two independent Vercel projects** connected to the same GitHub
repository:

- `centralize-admin-staging` tracks the `staging` Git branch, deploys to
  `https://centralize-admin-staging.vercel.app`, and uses the staging Contabo API.
- `centralize-admin` tracks `main` for the separate production website and API.

Vercel calls the live environment of **each project** "Production". Deploying
`staging` to the staging project's Production environment must not deploy the
`main` branch or modify the separate production project.

After a staging change, confirm the stable Vercel domain resolves to a deployment
whose Git commit SHA matches the current `staging` head; a successful Next.js CI
build is **not** proof that the stable domain received the new build. If branch
tracking is changed, an older deployment does not automatically become the current
branch build; trigger a new Git deployment and verify the resulting alias.

For service outages, dashboard widgets must show **unavailable**, not fabricated
zero metrics or an indefinite skeleton. HealthNet's independent service foundation
lives at `services/healthnet-admin`; the existing HQ-to-HealthNet data migration
remains staged separately.
