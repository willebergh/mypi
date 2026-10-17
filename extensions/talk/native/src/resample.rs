pub struct LinearResampler {
    source_rate: u32,
    target_rate: u32,
    position: f64,
    previous: Option<f32>,
    /// Previous sample plus the current input, reused across calls.
    scratch: Vec<f32>,
}

impl LinearResampler {
    pub fn new(source_rate: u32, target_rate: u32) -> anyhow::Result<Self> {
        if source_rate == 0 || target_rate == 0 {
            anyhow::bail!("audio sample rates must be non-zero");
        }
        Ok(Self {
            source_rate,
            target_rate,
            position: 0.0,
            previous: None,
            scratch: Vec::new(),
        })
    }

    pub fn process(&mut self, input: &[f32], output: &mut Vec<f32>) {
        if input.is_empty() {
            return;
        }
        if self.source_rate == self.target_rate {
            output.extend_from_slice(input);
            self.previous = input.last().copied();
            return;
        }

        let step = self.source_rate as f64 / self.target_rate as f64;
        let samples = &mut self.scratch;
        samples.clear();
        if let Some(previous) = self.previous {
            samples.push(previous);
        }
        samples.extend_from_slice(input);
        while self.position + 1.0 < samples.len() as f64 {
            let left = self.position.floor() as usize;
            let fraction = (self.position - left as f64) as f32;
            output.push(samples[left] * (1.0 - fraction) + samples[left + 1] * fraction);
            self.position += step;
        }
        self.position -= (samples.len() - 1) as f64;
        self.previous = input.last().copied();
    }

    pub fn reset(&mut self) {
        self.position = 0.0;
        self.previous = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resamples_without_losing_stream_continuity() {
        let mut resampler = LinearResampler::new(48_000, 24_000).unwrap();
        let mut output = Vec::new();
        resampler.process(&[0.0, 1.0, 2.0], &mut output);
        resampler.process(&[3.0, 4.0], &mut output);
        assert_eq!(output, vec![0.0, 2.0]);
    }

    /// The pre-scratch implementation, kept verbatim as the equivalence oracle.
    struct AllocatingResampler {
        step: f64,
        position: f64,
        previous: Option<f32>,
    }

    impl AllocatingResampler {
        fn process(&mut self, input: &[f32], output: &mut Vec<f32>) {
            let mut samples =
                Vec::with_capacity(input.len() + usize::from(self.previous.is_some()));
            if let Some(previous) = self.previous {
                samples.push(previous);
            }
            samples.extend_from_slice(input);
            while self.position + 1.0 < samples.len() as f64 {
                let left = self.position.floor() as usize;
                let fraction = (self.position - left as f64) as f32;
                output.push(samples[left] * (1.0 - fraction) + samples[left + 1] * fraction);
                self.position += self.step;
            }
            self.position -= (samples.len() - 1) as f64;
            self.previous = input.last().copied();
        }
    }

    #[test]
    fn reused_scratch_matches_the_allocating_path_and_keeps_its_buffer() {
        let input: Vec<f32> = (0..9_600)
            .map(|index| (index as f32 * 0.013).sin())
            .collect();
        for (source, target) in [(48_000, 24_000), (48_000, 44_100), (24_000, 48_000)] {
            let mut resampler = LinearResampler::new(source, target).unwrap();
            let mut oracle = AllocatingResampler {
                step: source as f64 / target as f64,
                position: 0.0,
                previous: None,
            };
            let (mut actual, mut expected) = (Vec::new(), Vec::new());
            let mut offset = 0;
            for chunk in [960, 480, 960, 1, 441, 960].iter().cycle() {
                let end = (offset + chunk).min(input.len());
                resampler.process(&input[offset..end], &mut actual);
                oracle.process(&input[offset..end], &mut expected);
                offset = end;
                if offset == input.len() {
                    break;
                }
            }
            assert_eq!(actual, expected, "{source} Hz -> {target} Hz");

            let scratch = resampler.scratch.as_ptr();
            resampler.process(&input[..960], &mut actual);
            assert_eq!(resampler.scratch.as_ptr(), scratch);
        }
    }
}
