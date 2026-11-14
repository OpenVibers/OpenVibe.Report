# Shared ratings

The `/ai` boards, comparison catalogue and model rating reads use Bench's fitted
ratings. Elo board reads use `openvibe-sdk/compare` `ratings.get(kind)`, cached for a
minute with the existing stale-source marker during an outage. Rows with fewer
than twenty eligible games are withheld. Exchange reads the same endpoint.
Model summaries are fitted by Bench too; Report has no local rating table.

The older cost and Pareto board reads and benchmark registry remain in place;
they are separate data products, not an alternative Elo calculation. The
incremental Bench table remains write-side accounting only. Design and Exchange
already send their arena votes to Bench.

Design's active `server/arena/store.js` reads Bench boards. Its legacy local
ratings table is retained for migration compatibility and is not a live rating
source. The optional legacy importer represents old votes as automatic-grader
evidence; those are not silently promoted to authenticated pairwise votes.

For Fable: rating, lower/upper confidence bounds, games, kind and model subject
are the shared numbers. Empty ratings mean fewer than twenty games, while a
failed source retains the existing unavailable/stale state. Existing catalogue
model matching keeps the Bench subject visible when joining a dated API name to
an Exchange catalogue slug.
