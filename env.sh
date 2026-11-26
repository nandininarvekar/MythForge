# Use the project-local Node 22. Run:  source env.sh
export PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/.tools/node/bin:$PATH"
echo "Using node $(node -v) from $(dirname "$(command -v node)")"
