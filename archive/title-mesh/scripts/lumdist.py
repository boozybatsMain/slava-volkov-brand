#!/usr/bin/env python3
"""Luminance percentiles inside the title: reference vs a ?layers=title render."""
import sys
import numpy as np
from PIL import Image
im = np.asarray(Image.open('reference/title-main.jpg').convert('RGB')).astype(int)
bg = im.min(2) > 238
P = [5, 10, 25, 50, 75, 90, 95]
print('ref  ', np.percentile(im.mean(2)[~bg], P).astype(int), ' blue-ness', round(float((im[..., 2] - im[..., 0])[~bg].mean()), 1))
m = np.asarray(Image.open(sys.argv[1]).convert('RGB')).astype(int)
d = np.abs(m - np.array([0xe4, 0xe2, 0xdd])).max(2) > 14
print('mine ', np.percentile(m.mean(2)[d], P).astype(int), ' blue-ness', round(float((m[..., 2] - m[..., 0])[d].mean()), 1))
