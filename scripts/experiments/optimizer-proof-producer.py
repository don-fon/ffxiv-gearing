"""Untrusted proof search. Only the independent checker may certify a result."""
from pathlib import Path
from fractions import Fraction
import argparse
import importlib.util
import json
import time


def load_kernel():
    spec = importlib.util.spec_from_file_location('proof_kernel', Path(__file__).with_name('optimizer-proof-kernel.py'))
    module = importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    return module


K = load_kernel()


class BudgetExceeded(RuntimeError):
    pass


class Producer:
    def __init__(self, source, candidate=None, seconds=30, max_nodes=1000000):
        self.start = time.monotonic();self.seconds = seconds;self.max_nodes = max_nodes
        self.nodes = 0;self.operations = 0
        self.problem = K.Problem(source, self.tick)
        # The checker accepts any permutation, then independently requires all
        # children of each selected raw domain. Ordering never removes options.
        self.order = sorted(range(len(self.problem.domains)), key=lambda i: len(self.problem.domains[i]))
        self.proposal = self.problem.proposed_witness(candidate)
        self.phases = []

    def tick(self):
        self.operations += 1
        if (self.operations == 1 or self.operations % 128 == 0) and time.monotonic() - self.start > self.seconds:
            raise BudgetExceeded('Proof generation time budget exhausted')
        if self.nodes > self.max_nodes:
            raise BudgetExceeded('Proof generation node budget exhausted')

    def phase(self, mode, threshold=None):
        problem = self.problem
        phase = {'mode': mode, 'witness': None, 'value': None, 'roots': []}
        self.phases.append(phase)
        best = None
        if mode == 'score' and self.proposal is not None:
            value = problem.evaluate_witness(self.proposal, mode, threshold)
            if value is not None:
                phase['witness'] = self.proposal;phase['value'] = str(value);best = value
        selection = [None] * len(problem.domains)

        def visit(depth, raw, selected, food_index):
            nonlocal best
            self.nodes += 1;self.tick()
            remaining = self.order[depth:];food = problem.foods[food_index]
            if problem.impossible(raw, selected, remaining, food, threshold):
                return 'I'
            bound = problem.bound(raw, selected, remaining, food, mode, threshold)
            if best is not None and (bound >= best if mode == 'minCRT' else bound <= best):
                return 'B'
            if not remaining:
                witness = {'food': food_index, 'selection': list(selection)}
                value = problem.evaluate_witness(witness, mode, threshold)
                if value is not None and (best is None or (value < best if mode == 'minCRT' else value > best)):
                    best = value;phase['witness'] = witness;phase['value'] = str(value)
                return 'L'
            index = remaining[0]
            children = []
            for option_index, option in enumerate(problem.domains[index]):
                selection[index] = option_index
                children.append(visit(depth + 1, K.add(raw, option['stats']), selected + [option], food_index))
            selection[index] = None
            return ['S', children]

        for food_index in range(len(problem.foods)):
            phase['roots'].append(visit(0, {}, [], food_index))
        return best

    def produce(self):
        threshold = None
        if self.problem.mode != 'none':
            minimum = self.phase('minCRT')
            if minimum is None:
                return
            maximum = self.phase('maxCRT')
            threshold = minimum + (maximum - minimum) * Fraction(3 if self.problem.mode == 'high' else 1, 4)
        self.phase('score', threshold)


def generate(source, candidate=None, seconds=30, max_nodes=1000000):
    start = time.monotonic();producer = None
    proof = {'version': K.VERSION, 'inputHash': K.input_hash(source), 'complete': False, 'order': [], 'phases': []}
    try:
        producer = Producer(source, candidate, seconds, max_nodes)
        producer.produce();proof['complete'] = True
    except (BudgetExceeded, K.Unsupported) as error:
        proof['reason'] = str(error)
    if producer is not None:
        proof.update(order=producer.order, phases=producer.phases, nodes=producer.nodes)
    proof['generationMs'] = (time.monotonic() - start) * 1000
    return proof


if __name__ == '__main__':
    parser = argparse.ArgumentParser();parser.add_argument('--input', type=Path, required=True);parser.add_argument('--candidate', type=Path);parser.add_argument('--output', type=Path, required=True);parser.add_argument('--seconds', type=float, default=30);parser.add_argument('--nodes', type=int, default=1000000);args = parser.parse_args()
    source = json.loads(args.input.read_text());candidate = json.loads(args.candidate.read_text()) if args.candidate else None
    proof = generate(source, candidate, args.seconds, args.nodes);args.output.write_text(json.dumps(proof, ensure_ascii=False, separators=(',', ':')))
    print(json.dumps({key: value for key, value in proof.items() if key not in ('phases', 'order')}))
