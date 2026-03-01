package com.example.smartgoprototype.ui.dashboard

import com.example.smartgoprototype.domain.model.Route

data class DashboardUiState(
    val isInitialLoading: Boolean = false,
    val isRefreshing: Boolean = false,
    val routes: List<Route> = emptyList(),
    val errorMessage: String? = null
)
