import sys

def solve() -> None:
    data = sys.stdin.read().strip().split()
    if not data:
        return
    a, b = map(int, data[:2])
    print(a + b)

if __name__ == "__main__":
    solve()









