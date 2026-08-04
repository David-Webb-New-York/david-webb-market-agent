# David Webb Secondary Market Agent

Searches the web for David Webb pieces currently listed for sale or sold at
auction, and logs piece details + pricing to a CSV you can open in Excel or
plug into Power BI / Fabric.

## Setup (in Cursor)

1. Open this folder in Cursor.
2. Get an API key: https://console.anthropic.com/settings/keys
3. In the terminal:
   ```
   npm install
   export ANTHROPIC_API_KEY=sk-ant-your-key-here
   node agent.js
   ```
   (Node 18+ required — has built-in `fetch`. Check with `node -v`.)

4. Check `output/david-webb-market-data.csv` — new rows get appended every run.
   `output/snapshots/` keeps a dated JSON copy of each run for auditing.

## Customizing what it searches for

Edit the `QUERIES` array at the top of `agent.js`. Right now it covers:
- 1stDibs by category (bracelet, ring, earrings, brooch, necklace)
- Named iconic pieces (zebra bracelet, frog bracelet, cross pendant)
- Sotheby's / Christie's auction results

Add more specific queries as you think of them — e.g. `"David Webb hammerhead
bracelet price"` or `"David Webb Kazanjian sapphire"` for specific historic
pieces you want to track over time.

## Running it on a schedule (so you don't have to remember)

**Easiest: cron on your own machine (Mac/Linux)**
```
crontab -e
```
Add a line to run it every Monday at 8am:
```
0 8 * * 1 cd /path/to/david-webb-agent && /usr/local/bin/node agent.js >> run.log 2>&1
```

**Better for reliability: GitHub Actions**
Push this repo to GitHub, add `ANTHROPIC_API_KEY` as a repo secret, then add
`.github/workflows/weekly-scan.yml`:
```yaml
name: Weekly David Webb Market Scan
on:
  schedule:
    - cron: '0 13 * * 1'  # Monday 8am ET
  workflow_dispatch: {}     # lets you also trigger manually from GitHub UI
jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm install
      - run: node agent.js
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
      - run: |
          git config user.name "market-agent"
          git config user.email "agent@davidwebb.local"
          git add output/
          git commit -m "Weekly market scan $(date +%F)" || echo "No changes"
          git push
```
This commits fresh data back to the repo every week automatically — no
machine of yours needs to be on.

## Feeding this into Fabric / Power BI

Since you're already building out Bronze/Silver/Gold layers from Business
Central at David Webb: the CSV output here is a natural Bronze-layer source.
Simplest path is to have Fabric read `output/david-webb-market-data.csv`
straight from GitHub (or drop it into a OneDrive/SharePoint folder the
pipeline already watches), then dedupe/clean into Silver.

## Notes on data quality

- 1stDibs prices are **dealer asking prices**, not what dealers paid or what
  sellers actually receive after commission — treat as a retail-resale
  comp, not a wholesale/liquidation value.
- Auction "hammer" prices are real transaction prices but don't include
  buyer's premium (typically +20-27% at major houses).
- The model can occasionally miscategorize a piece or miss a price if a
  listing page didn't load cleanly — spot check the snapshots periodically
  rather than trusting the CSV blindly.
