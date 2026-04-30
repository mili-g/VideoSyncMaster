from __future__ import annotations

import torch
import torch.nn.functional as F


def find_most_similar_cosine(query_vector: torch.Tensor, matrix: torch.Tensor) -> torch.Tensor:
    query_vector = query_vector.float()
    matrix = matrix.float()
    similarities = F.cosine_similarity(query_vector, matrix, dim=1)
    return torch.argmax(similarities)
