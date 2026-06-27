import { stdout } from "node:process";

const VERBS = [
	"thinking",
	"pondering",
	"contemplating",
	"analyzing",
	"reasoning",
	"considering",
	"deliberating",
	"processing",
	"ruminating",
	"cogitating",
	"synthesizing",
	"evaluating",
	"computing",
	"untangling",
	"decoding",
	"brainstorming",
	"connecting dots",
	"consulting the oracle",
	"reading tea leaves",
	"asking the magic 8-ball",
	"summoning neurons",
	"herding thoughts",
	"wrangling tokens",
	"juggling concepts",
	"assembling wisdom",
	"daydreaming productively",
	"staring into the void",
	"kicking lazy neurons",
	"brewing ideas",
	"defragmenting brain",
	"downloading inspiration",
	"compiling thoughts",
	"garbage collecting",
	"refactoring reality",
	"mining for insight",
	"spinning up hamster wheels",
	"consulting ancient scrolls",
	"shaking the magic conch",
	"reticulating splines",
	"calibrating nonsense detector",
	"warming up the flux capacitor",
	"asking a rubber duck",
	"negotiating with entropy",
	"alphabetizing chaos",
	"transcending limitations",
	"counting electric sheep",
	"polishing neurons",
	"channeling deep thought",
	"rebooting imagination",
	"performing divination",
	"bribing the CPU",
	"yelling at electrons",
	"consulting stack overflow",
	"invoking ancient APIs",
	"sacrificing to the compiler gods",
	"wrestling with regex",
	"bargaining with the scheduler",
	"guilt-tripping idle cores",
	"speed-reading Wikipedia",
	"performing interpretive math",
	"astral projecting to the answer",
	"phoning a friend",
	"rolling for intelligence",
	"nat 20 on perception check",
	"asking the elders",
	"flipping through the manual",
	"solving a captcha internally",
	"microdosing knowledge",
	"overcooking the data",
	"petting a virtual cat for focus",
	"stacking tokens like Jenga",
	"waiting for the bus to cleverness",
	"speedrunning logic",
	"doing mental parkour",
	"vibing with the matrix",
	"buffering brilliance",
	"reverse-engineering the question",
	"simmering on low heat",
	"whispering to tensors",
	"poking the attention mechanism",
	"holding a séance with training data",
	"doing mental gymnastics",
	"plotting world domination quietly",
	"consulting the void (it answered)",
	"loading personality module",
	"converting caffeine to tokens",
	"engaging turbo mode",
	"unfolding higher dimensions",
	"convincing bits to cooperate",
	"meditating aggressively",
	"rotating the problem in 4D",
	"asking the hamsters to run faster",
	"performing dark arithmetic",
	"summoning the spirit of Turing",
	"calculating the meaning of life",
	"debugging the universe",
	"applying percussive maintenance",
	"teaching electrons to think",
];

const pick = (): string => VERBS[Math.floor(Math.random() * VERBS.length)] as string;

export type Spinner = { stop: () => void };

/**
 * Start a thinking spinner. Writes a dim message, cycles every interval.
 * Call stop() to clear the current line and return cursor to start.
 */
export const startSpinner = (intervalMs = 2500): Spinner => {
	let current = pick();

	const write = (text: string) => {
		stdout.write(`\r\x1b[K\x1b[2m${text}…\x1b[0m`);
	};

	write(current);

	const timer = setInterval(() => {
		current = pick();
		write(current);
	}, intervalMs);

	return {
		stop: () => {
			clearInterval(timer);
			stdout.write("\r\x1b[K");
		},
	};
};
