import type { Question } from "@eplp/protocol";

function rng(seed: number) {
    let s = seed >>> 0 || 1;
    return () => {
        s ^= s << 13;
        s ^= s >>> 17;
        s ^= s << 5;
        return (s >>> 0) / 0x1_0000_0000;
    };
}

type Maker = (r: () => number) => {
    text: string;
    answer: string;
    wrong: string[];
};

const pick = <T>(r: () => number, xs: readonly T[]): T =>
    xs[Math.floor(r() * xs.length)]!;
const int = (r: () => number, lo: number, hi: number) =>
    lo + Math.floor(r() * (hi - lo + 1));

const physics: Maker[] = [
    (r) => {
        const m = int(r, 2, 12);
        const v = int(r, 2, 10);
        const ke = (m * v * v) / 2;
        return {
            text: `A ${m} kg cart moves at ${v} m/s. What is its kinetic energy?`,
            answer: `${ke} J`,
            wrong: [`${m * v} J`, `${m * v * v} J`, `${ke / 2} J`],
        };
    },
    (r) => {
        const v = int(r, 6, 24);
        const ohm = pick(r, [2, 3, 4, 6]);
        return {
            text: `A ${v} V battery drives current through a ${ohm} Ω resistor. What current flows?`,
            answer: `${v / ohm} A`,
            wrong: [`${v * ohm} A`, `${(v / ohm) * 2} A`, `${v + ohm} A`],
        };
    },
    (r) => {
        const f = int(r, 10, 60);
        const m = pick(r, [2, 4, 5]);
        return {
            text: `A net force of ${f} N acts on a ${m} kg block. What is its acceleration?`,
            answer: `${f / m} m/s²`,
            wrong: [`${f * m} m/s²`, `${f / m / 2} m/s²`, `${f - m} m/s²`],
        };
    },
    (r) => {
        const h = int(r, 5, 45);
        return {
            text: `An object is lifted ${h} m against gravity (g = 10 m/s²). How much potential energy does 1 kg gain?`,
            answer: `${10 * h} J`,
            wrong: [`${h} J`, `${5 * h} J`, `${20 * h} J`],
        };
    },
    (r) => {
        const f = pick(r, [50, 100, 200, 400]);
        const lambda = pick(r, [2, 3, 4]);
        return {
            text: `A wave has frequency ${f} Hz and wavelength ${lambda} m. What is its speed?`,
            answer: `${f * lambda} m/s`,
            wrong: [
                `${f / lambda} m/s`,
                `${f + lambda} m/s`,
                `${f * lambda * 2} m/s`,
            ],
        };
    },
];

const ELEMENTS = [
    ["Hydrogen", 1, 1],
    ["Carbon", 6, 12],
    ["Nitrogen", 7, 14],
    ["Oxygen", 8, 16],
    ["Sodium", 11, 23],
    ["Magnesium", 12, 24],
    ["Chlorine", 17, 35.5],
    ["Calcium", 20, 40],
] as const;

const chemistry: Maker[] = [
    (r) => {
        const [name, z] = pick(r, ELEMENTS);
        const others = ELEMENTS.filter((e) => e[0] !== name);
        return {
            text: `Which element has atomic number ${z}?`,
            answer: name,
            wrong: [others[0]![0], others[3]![0], others[5]![0]].map(String),
        };
    },
    (r) => {
        const n = int(r, 2, 6);
        return {
            text: `How many grams are in ${n} mol of water (H₂O, 18 g/mol)?`,
            answer: `${18 * n} g`,
            wrong: [`${16 * n} g`, `${18 + n} g`, `${9 * n} g`],
        };
    },
    (r) => {
        const ph = int(r, 1, 6);
        return {
            text: `A solution has [H⁺] = 10⁻${ph} mol/L. What is its pH?`,
            answer: `${ph}`,
            wrong: [`${14 - ph}`, `${ph + 1}`, `${ph * 2}`],
        };
    },
    (r) => {
        const g = pick(r, [
            ["CO₂", 44],
            ["NH₃", 17],
            ["CH₄", 16],
            ["NaCl", 58.5],
        ] as const);
        return {
            text: `What is the molar mass of ${g[0]}?`,
            answer: `${g[1]} g/mol`,
            wrong: [
                `${g[1] + 2} g/mol`,
                `${g[1] * 2} g/mol`,
                `${g[1] - 4} g/mol`,
            ],
        };
    },
];

const maths: Maker[] = [
    (r) => {
        const a = int(r, 2, 9);
        const x = int(r, 2, 12);
        const b = int(r, 1, 20);
        return {
            text: `Solve for x: ${a}x + ${b} = ${a * x + b}`,
            answer: `${x}`,
            wrong: [`${x + 1}`, `${x - 1}`, `${x + a}`],
        };
    },
    (r) => {
        const n = int(r, 3, 6);
        const fact = (k: number): number => (k <= 1 ? 1 : k * fact(k - 1));
        return {
            text: `In how many ways can ${n} distinct books be arranged in a row?`,
            answer: `${fact(n)}`,
            wrong: [`${n * n}`, `${fact(n - 1)}`, `${2 ** n}`],
        };
    },
    (r) => {
        const a = int(r, 1, 6);
        return {
            text: `A right triangle has legs ${a * 3} and ${a * 4}. What is its hypotenuse?`,
            answer: `${a * 5}`,
            wrong: [`${a * 7}`, `${a * 6}`, `${a * 4 + 1}`],
        };
    },
    (r) => {
        const k = int(r, 2, 6);
        return {
            text: `What is the derivative of x^${k} at x = 1?`,
            answer: `${k}`,
            wrong: [`${k - 1}`, `${k + 1}`, `1`],
        };
    },
    (r) => {
        const n = int(r, 5, 20);
        return {
            text: `What is the sum 1 + 2 + … + ${n}?`,
            answer: `${(n * (n + 1)) / 2}`,
            wrong: [`${n * n}`, `${(n * (n - 1)) / 2}`, `${n * (n + 1)}`],
        };
    },
];

export const SUBJECTS = {
    Physics: physics,
    Chemistry: chemistry,
    Mathematics: maths,
} as const;

export function demoQuestions(
    subject: keyof typeof SUBJECTS,
    count: number,
    seed: number,
): Question[] {
    const r = rng(seed);
    const makers = SUBJECTS[subject];
    return Array.from({ length: count }, (_, i) => {
        const { text, answer, wrong } = makers[i % makers.length]!(r);
        const options = [...new Set([answer, ...wrong])];
        for (const filler of ["None of these", "Cannot be determined"])
            if (options.length < 4) options.push(filler);
        const shuffled = options.slice(0, 4).sort(() => r() - 0.5);
        return {
            text: `${text}`,
            options: shuffled as [string, string, string, string],
            correct: shuffled.indexOf(answer) as 0 | 1 | 2 | 3,
        };
    });
}
