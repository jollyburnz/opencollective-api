#!/usr/bin/env bash

set -e

# Only run migrations automatically on staging and production
if [ "$SEQUELIZE_ENV" = "staging" ] || [ "$SEQUELIZE_ENV" = "production" ]; then
  echo "- running db:migrate on $SEQUELIZE_ENV environment"
  npm run db:migrate
  exit $?; # exit with return code of previous command
fi

# On any other environment, first let's check if postgres is installed
if command -v psql > /dev/null; then
  echo "✓ Postgres installed"
else
  echo "𐄂 psql command doesn't exist. Make sure you have Postgres installed ($> brew install postgres)"
fi

# On circleci environment
if [ "$NODE_ENV" = "circleci" ]; then
  echo "- setup db user and run migration if any"
  npm run db:setup
  npm run db:migrate
else
  if psql -lqt | cut -d \| -f 1 | grep -qw d4qo4nhnf5jad2; then
    echo "✓ d4qo4nhnf5jad2 exists"
  else
    echo "- restoring d4qo4nhnf5jad2";
    ./scripts/db_restore.sh -d d4qo4nhnf5jad2 -f test/dbdumps/opencollective_dvl.pgsql
  fi
  echo "- running migration if any"
  PG_DATABASE=d4qo4nhnf5jad2 npm run db:migrate
fi

echo ""
echo "You can now start the open collective api server by running:"
echo "$> npm run dev"
echo ""
