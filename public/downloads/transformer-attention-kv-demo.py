"""纯 Python 教学演示；运行：python3 transformer-attention-kv-demo.py。

固定随机权重，2 层、单头、隐藏维度 4、词表 8；无训练，无真实语言能力。
包括 RMSNorm、QKV、二维配对 RoPE、因果 Attention、残差和 SwiGLU。
为方便阅读使用 list 和循环；不代表生产 GPU 实现或性能。
"""

import math
import random


DIM = 4
FFN = 6
VOCAB = 8
LAYERS = 2
rng = random.Random(42)


def matrix(rows, cols):
    return [[rng.uniform(-0.5, 0.5) for _ in range(cols)] for _ in range(rows)]


def linear(x, weight):
    """行向量 [Din] 乘矩阵 [Din,Dout]，省略 bias。"""
    return [sum(x[i] * weight[i][j] for i in range(len(x)))
            for j in range(len(weight[0]))]


def add(a, b):
    return [x + y for x, y in zip(a, b)]


def rmsnorm(x):
    # 教学简化：可学习缩放 gamma 固定为全 1。
    scale = math.sqrt(sum(v * v for v in x) / len(x) + 1e-6)
    return [v / scale for v in x]


def rope(x, position):
    """相邻维度配对，采用基础 RoPE；实际实现可能采用不同配对布局。"""
    result = []
    for i in range(0, len(x), 2):
        angle = position / (10000 ** (i / len(x)))
        c, s = math.cos(angle), math.sin(angle)
        result.extend([x[i] * c - x[i + 1] * s,
                       x[i] * s + x[i + 1] * c])
    return result


def softmax(scores):
    maximum = max(scores)
    exps = [math.exp(s - maximum) for s in scores]
    total = sum(exps)
    return [e / total for e in exps]


def attention(q, keys, values):
    # keys 已按因果规则截取，等价于将不可见位置的分数置为 -inf。
    scores = [sum(a * b for a, b in zip(q, k)) / math.sqrt(len(q)) for k in keys]
    weights = softmax(scores)
    output = [sum(w * v[j] for w, v in zip(weights, values))
              for j in range(len(values[0]))]
    return output, weights


embedding = matrix(VOCAB, DIM)
lm_head = matrix(DIM, VOCAB)
params = [dict(q=matrix(DIM, DIM), k=matrix(DIM, DIM), v=matrix(DIM, DIM),
               o=matrix(DIM, DIM), gate=matrix(DIM, FFN), up=matrix(DIM, FFN),
               down=matrix(FFN, DIM)) for _ in range(LAYERS)]


def new_cache():
    return [dict(k=[], v=[]) for _ in range(LAYERS)]


def forward(ids, cache=None):
    """处理未入缓存的 token；返回各输入位置预测下一个 token 的 logits。

    cache=None 时完整因果前向；传入缓存时更新每层的 K/V。
    同一函数支持单 token decode 和含多个新 token 的 chunk。
    """
    if cache is None:
        cache = new_cache()
    offset = len(cache[0]['k'])
    assert all(len(c['k']) == len(c['v']) == offset for c in cache)
    hidden = [embedding[token][:] for token in ids]
    for p, c in zip(params, cache):
        normalized = [rmsnorm(x) for x in hidden]
        queries = [rope(linear(x, p['q']), offset + i) for i, x in enumerate(normalized)]
        keys = [rope(linear(x, p['k']), offset + i) for i, x in enumerate(normalized)]
        values = [linear(x, p['v']) for x in normalized]
        c['k'].extend(keys)
        c['v'].extend(values)
        updated = []
        for i, (x, q) in enumerate(zip(hidden, queries)):
            # 非方形 mask 的要点：第 i 个新位置可见 offset+i+1 个 key。
            visible = offset + i + 1
            mixed, _ = attention(q, c['k'][:visible], c['v'][:visible])
            after_attention = add(x, linear(mixed, p['o']))
            z = rmsnorm(after_attention)
            gate, up = linear(z, p['gate']), linear(z, p['up'])
            gated = [(g / (1 + math.exp(-g))) * u for g, u in zip(gate, up)]
            updated.append(add(after_attention, linear(gated, p['down'])))
        hidden = updated
    return [linear(rmsnorm(x), lm_head) for x in hidden]


def max_error(left, right):
    return max(abs(a - b) for row_a, row_b in zip(left, right)
               for a, b in zip(row_a, row_b))


def main():
    q = [1.0, 0.0]
    keys = [[1.0, 0.0], [0.0, 1.0], [1.0, 1.0]]
    values = [[2.0, 0.0], [0.0, 2.0], [2.0, 2.0]]
    out, weights = attention(q, keys, values)
    assert math.isclose(sum(weights), 1.0)
    print('1. Attention 手算示例（当前位置可看全部三个 key）：')
    print('   缩放分数：', [round(v, 6) for v in [1 / math.sqrt(2), 0, 1 / math.sqrt(2)]])
    print('   权重：', [round(w, 6) for w in weights])
    print('   加权结果：', [round(v, 6) for v in out])

    ids = [1, 3, 2, 5, 4]
    full = forward(ids)
    cache = new_cache()
    incremental = []
    for token in ids:
        incremental.extend(forward([token], cache))
    error = max_error(full, incremental)
    assert error < 1e-10
    print(f'2. 全序列前向 vs 逐 token KV Cache：最大 logits 误差 {error:.3g}')

    chunk_cache = new_cache()
    chunked = forward(ids[:2], chunk_cache) + forward(ids[2:], chunk_cache)
    assert max_error(full, chunked) < 1e-10
    print('3. 两个 token prefill + 三个新 token：非方形因果 mask 验证通过')

    changed_future = forward([1, 3, 7, 6, 0])
    assert max_error(full[:2], changed_future[:2]) < 1e-10
    print('4. 修改未来 token，前两个位置的输出保持一致：因果隔离验证通过')

    cache = new_cache()
    prompt = [1, 3, 2]
    logits = forward(prompt, cache)[-1]
    print('5. 生成时序（token ID 无语言意义）：')
    for step in range(3):
        token = max(range(VOCAB), key=lambda i: logits[i])
        print(f'   选出输出 token {step + 1}: {token}；此时每层缓存长度 {len(cache[0]["k"])}')
        if step < 2:
            logits = forward([token], cache)[-1]
    print('   最后刚选出的 token 尚未送入 forward，所以还没有进入 KV Cache。')
    print('全部验证通过。这里验证的是计算等价性，不是模型回答质量。')


if __name__ == '__main__':
    main()
