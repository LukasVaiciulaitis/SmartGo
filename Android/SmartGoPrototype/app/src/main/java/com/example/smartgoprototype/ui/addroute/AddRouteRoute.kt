package com.example.smartgoprototype.ui.addroute

import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.hilt.navigation.compose.hiltViewModel

@Composable
fun AddRouteRoute(
    onBack: () -> Unit,
    onSaved: () -> Unit,
    viewModel: AddRouteViewModel = hiltViewModel()
) {
    val uiState by viewModel.uiState.collectAsState()

    AddRouteScreen(
        uiState = uiState,
        onBack = onBack,
        onTitleChange = viewModel::onTitleChange,
        onOriginSelected = viewModel::onOriginSelected,
        onDestinationSelected = viewModel::onDestinationSelected,
        onTravelModeSelected = viewModel::onTravelModeSelected,
        onArriveByChange = viewModel::onArriveByChange,
        onToggleDay = viewModel::toggleDay,
        onSave = { viewModel.save(onSaved) }
    )
}