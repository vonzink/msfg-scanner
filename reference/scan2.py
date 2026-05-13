import sys
import os
import cv2
import numpy as np


def enhance_document(image_path):
    image = cv2.imread(image_path)
    if image is None:
        raise ValueError(f"Could not open image: {image_path}")

    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)

    # Improve local contrast without blowing out text
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    gray = clahe.apply(gray)

    # Light denoise
    gray = cv2.GaussianBlur(gray, (3, 3), 0)

    # Better "clean grayscale" version
    clean = cv2.convertScaleAbs(gray, alpha=1.15, beta=8)

    # Safer black/white version using Otsu
    _, bw = cv2.threshold(
        clean, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU
    )

    return clean, bw


def main():
    if len(sys.argv) < 2:
        print("Usage:")
        print("  python3 scan2.py /full/path/to/image.jpg")
        print("")
        print("Mac tip: type `python3 scan2.py ` and drag the image into Terminal.")
        sys.exit(1)

    image_path = sys.argv[1]

    if not os.path.exists(image_path):
        print(f"File not found: {image_path}")
        sys.exit(1)

    clean, bw = enhance_document(image_path)

    base, _ = os.path.splitext(image_path)
    clean_path = base + "_clean.png"
    bw_path = base + "_bw.png"

    cv2.imwrite(clean_path, clean)
    cv2.imwrite(bw_path, bw)

    print(f"Saved clean scan: {clean_path}")
    print(f"Saved B/W scan:   {bw_path}")


if __name__ == "__main__":
    main()